/**
 * madangs.com 경매 데이터 스크래퍼
 * https://madangs.com/search/schedule?date=...
 *
 * 전략:
 *  1. 날짜별 순회 (start_date → end_date, 1일씩 증가)
 *  2. 날짜별로 /api/search/schedule JSON API → 60건씩 페이지네이션
 *  3. 각 물건 상세: /caview?m_code={m_code} HTML GET → 정규식 파싱
 *     - .case_basic → 경매구분~매각일 항목
 *     - #schedule-history → 기일내역
 *     - img[src*="cdn.madangs.com/img/"] → 사진 URL
 *  4. Parquet(GZIP) 저장
 *
 * 실행:
 *  node --experimental-strip-types scripts/scrape-madangs.ts [옵션]
 * 옵션:
 *  --start-date  2024-01-01   수집 시작일 (기본: 2024-01-01)
 *  --end-date    2024-01-31   수집 종료일 (기본: 오늘)
 *  --limit       10           날짜당 최대 수집 건수 (0=전체)
 *  --state-file  /tmp/madangs-state.json   증분 state 파일 경로
 *  --output      /tmp/madangs.parquet      출력 파일 경로
 *  --dry-run                  수집 없이 리스트만 확인
 */

import { chromium, type BrowserContext } from 'playwright';
import parquet from '@dsnp/parquetjs';
import fs from 'node:fs';

// ── CLI 파싱 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const today = new Date().toISOString().slice(0, 10);
const startDate = getArg('--start-date', '2024-01-01');
const endDate = getArg('--end-date', today);
const limitPerDate = parseInt(getArg('--limit', '0'), 10);
const stateFile = getArg('--state-file', '');
const outputFile = getArg('--output', '/tmp/madangs.parquet');
const dryRun = args.includes('--dry-run');

// ── 상수 ─────────────────────────────────────────────────────────────────────
const BASE_URL = 'https://madangs.com';
const LIST_API = `${BASE_URL}/api/search/schedule`;
const PAGE_SIZE = 60;

// ── 타입 ─────────────────────────────────────────────────────────────────────
interface ListItem {
  m_code: string;
  bubwon: string;
  case_num: string;
  addr: string;
  img_url: string;
  eval_price_v: number;
  sold_price: number;
  use_type: string;
  m_bid_date: string;
  m_state_class: string;
  m_state_text: string;
  state: string;
}

interface ScheduleRecord {
  date: string;
  result: string;
  price: string;
  lowPrice: string;
}

interface AuctionRecord {
  m_code: string;
  collectedDate: string;
  bubwon: string;
  caseNum: string;
  address: string;
  photos: string;
  evalPrice: string;
  soldPrice: string;
  useType: string;
  bidDate: string;
  stateCode: string;
  state: string;
  auctionType: string;
  landArea: string;
  buildArea: string;
  appraisalPrice: string;
  minPrice: string;
  deposit: string;
  saleDate: string;
  caseBasicExtra: string;
  scheduleRecords: string;
}

// ── State 관리 ────────────────────────────────────────────────────────────────
interface State {
  seenMCodes: Record<string, string>;
  lastRunAt: string;
}

function loadState(file: string): State {
  if (!file || !fs.existsSync(file)) return { seenMCodes: {}, lastRunAt: '' };
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { seenMCodes: {}, lastRunAt: '' }; }
}

function saveState(file: string, state: State): void {
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// ── HTML 파싱 헬퍼 ──────────────────────────────────────────────────────────
function decodeHtml(str: string): string {
  return str
    .replace(/&#x[0-9a-fA-F]+;/g, '')  // &#xe887; 같은 아이콘 코드 제거
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCaseBasic(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  // case_basic 섹션 추출 (PC 버전 우선, 없으면 mobile)
  let sectionStart = html.indexOf('class="case_basic pc"');
  if (sectionStart < 0) sectionStart = html.indexOf('class="case_basic mobile"');
  if (sectionStart < 0) return result;

  const sectionEnd = html.indexOf('</section>', sectionStart);
  const section = html.substring(sectionStart, sectionEnd > 0 ? sectionEnd : sectionStart + 5000);

  // case_basic_inner 항목들 파싱
  const innerRe = /case_basic_title"[^>]*>([\s\S]*?)<\/span>[\s\S]*?case_basic_text"[^>]*>([\s\S]*?)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = innerRe.exec(section)) !== null) {
    const label = decodeHtml(m[1].replace(/<[^>]+>/g, ''));
    const value = decodeHtml(m[2].replace(/<[^>]+>/g, ''));
    if (label && value) result[label] = value;
  }
  return result;
}

function extractScheduleRecords(html: string): ScheduleRecord[] {
  const records: ScheduleRecord[] = [];
  const startIdx = html.indexOf('id="schedule-history"');
  if (startIdx < 0) return records;

  // 다음 주요 섹션까지만 파싱
  const nextSection = html.indexOf('<div class="mul_section', startIdx + 100);
  const sectionHtml = html.substring(startIdx, nextSection > 0 ? nextSection : startIdx + 10000);

  // bid_date_inner 항목 파싱 (접힌 것 포함 - HTML에 이미 포함됨)
  const itemRe = /<div class="bid_date_inner[^"]*">([\s\S]*?)(?=<div class="bid_date_inner|<\/div>\s*<\/div>\s*<\/div>)/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(sectionHtml)) !== null) {
    const item = m[1];
    const dateMatch = item.match(/<span class="date">([^<]+)<\/span>/);
    const onlyStateMatch = item.match(/<span class="only_state">([^<]+)<\/span>/);
    const stateMatch = item.match(/<span class="state[^"]*">([^<]+)<\/span>/);
    const soldPriceMatch = item.match(/<span class="sold_price">([^<]+)<\/span>/);
    const lowPriceMatch = item.match(/<span class="price low_price">([^<]+)<\/span>/);

    if (dateMatch) {
      records.push({
        date: dateMatch[1].trim(),
        result: (onlyStateMatch?.[1] ?? stateMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
        price: (soldPriceMatch?.[1] ?? '').trim(),
        lowPrice: (lowPriceMatch?.[1] ?? '').trim(),
      });
    }
  }
  return records;
}

function extractPhotos(html: string, mCode: string): string[] {
  const cCode = mCode.substring(0, 13); // c_code prefix (m_code without last 3 digits)
  const re = /https:\/\/cdn\.madangs\.com\/img\/([A-Za-z0-9]+)\.(?:jpg|jpeg|png|webp)/gi;
  const seen = new Set<string>();
  const photos: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[0];
    if (!seen.has(url) && m[1].startsWith(cCode)) {
      seen.add(url);
      photos.push(url);
    }
  }
  return photos;
}

// ── 리스트 API 호출 ────────────────────────────────────────────────────────
async function fetchListPage(ctx: BrowserContext, date: string, pageNum: number): Promise<{ items: ListItem[]; total: number }> {
  const params = new URLSearchParams({
    'query[date]': date,
    'query[court]': '99',
    'query[use_type]': '',
    'query[status]': '',
    'query[share]': '2',
    'query[sort]': 'view_desc',
    'query[theme]': 'schedule',
    'query[listType]': '1',
    'query[view_mode]': 'court',
    'query[page]': String(pageNum),
  });

  const res = await ctx.request.get(`${LIST_API}?${params}`, {
    headers: {
      Referer: `${BASE_URL}/search/schedule?date=${date}&court=99&view_mode=court&page=`,
      Accept: 'application/json',
    },
    timeout: 20000,
  });

  const data = await res.json() as Record<string, unknown>;
  if (!data.success) return { items: [], total: 0 };
  const d = data.data as Record<string, unknown> | undefined;
  if (!d?.list) return { items: [], total: 0 };

  const list = d.list as Record<string, unknown>[];
  const total = Number(d.rows ?? list.length);

  const items: ListItem[] = list.map((item) => {
    const ms = item.m_state as { state?: string; class?: string } | null;
    return {
      m_code: String(item.m_code ?? ''),
      bubwon: String(item.bubwon ?? ''),
      case_num: String(item.case_num ?? ''),
      addr: String(item.addr ?? ''),
      img_url: String(item.img_url ?? ''),
      eval_price_v: Number(item.eval_price_v ?? 0),
      sold_price: Number(item.sold_price ?? 0),
      use_type: String(item.use_type ?? ''),
      m_bid_date: String(item.m_bid_date ?? ''),
      m_state_class: ms?.class ?? '',
      m_state_text: ms?.state ?? '',
      state: String(item.state ?? ''),
    };
  });

  return { items, total };
}

// ── 상세 HTML 수집 ─────────────────────────────────────────────────────────
async function fetchDetailHtml(ctx: BrowserContext, mCode: string): Promise<string> {
  const res = await ctx.request.get(`${BASE_URL}/caview?m_code=${mCode}`, {
    headers: {
      Referer: `${BASE_URL}/search/schedule`,
      Accept: 'text/html,application/xhtml+xml',
    },
    timeout: 25000,
  });
  return await res.text();
}

// ── 날짜 유틸 ──────────────────────────────────────────────────────────────
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function totalDays(from: string, to: string): number {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
}

// ── 메인 ──────────────────────────────────────────────────────────────────
console.log('=== madangs.com 경매 데이터 수집 시작 ===');
console.log(`기간: ${startDate} ~ ${endDate}`);
console.log(`limit: ${limitPerDate === 0 ? '전체' : limitPerDate + '건/일'}, dry-run: ${dryRun}`);

const state = loadState(stateFile);
console.log(`기수집 m_code: ${Object.keys(state.seenMCodes).length}개\n`);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'ko-KR',
});

// 쿠키 취득 (메인 페이지 방문)
const homePage = await ctx.newPage();
await homePage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
await homePage.close();

const allResults: AuctionRecord[] = [];
const newMCodes: Record<string, string> = {};
let totalSkipped = 0;
let totalNew = 0;
let totalDetailCollected = 0;

const numDays = totalDays(startDate, endDate);
let dayIdx = 0;
let currentDate = startDate;

while (currentDate <= endDate) {
  dayIdx++;
  console.log(`[${dayIdx}/${numDays}] ${currentDate} 수집 시작...`);

  // 날짜별 전체 리스트 수집 (페이지네이션)
  const allItemsForDate: ListItem[] = [];
  let pageTotal = 0;

  for (let p = 1; p <= 50; p++) {
    const { items, total } = await fetchListPage(ctx, currentDate, p);
    if (p === 1) {
      pageTotal = total;
      console.log(`  총 ${total}건`);
    }
    if (items.length === 0) break;
    allItemsForDate.push(...items);
    if (allItemsForDate.length >= pageTotal && pageTotal > 0) break;
    if (items.length < PAGE_SIZE) break;
  }

  // m_code 기준 중복 제거 (API가 동일 아이템 반환하는 경우)
  const seenInPage = new Set<string>();
  const uniqueItems = allItemsForDate.filter(item => {
    if (seenInPage.has(item.m_code)) return false;
    seenInPage.add(item.m_code);
    return true;
  });

  // 신규 vs 스킵
  const newItems = uniqueItems.filter(item => !state.seenMCodes[item.m_code]);
  totalSkipped += uniqueItems.length - newItems.length;
  totalNew += newItems.length;
  console.log(`  신규: ${newItems.length}건, 스킵: ${uniqueItems.length - newItems.length}건`);

  if (dryRun) {
    newItems.slice(0, 3).forEach(item =>
      console.log(`  [dry] ${item.case_num} | ${item.use_type} | ${item.addr.substring(0, 40)}`)
    );
    currentDate = addDays(currentDate, 1);
    continue;
  }

  const targets = limitPerDate > 0 ? newItems.slice(0, limitPerDate) : newItems;

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    console.log(`  [${i + 1}/${targets.length}] ${item.case_num} 상세 수집...`);

    try {
      const html = await fetchDetailHtml(ctx, item.m_code);

      // case_basic 파싱 (경매구분~매각일)
      const cb = extractCaseBasic(html);
      const knownKeys = ['경매구분', '토지', '건물', '감정가', '최저가', '보증금', '매각일', '용도'];
      const extraKeys = Object.keys(cb).filter(k => !knownKeys.includes(k));
      const extra: Record<string, string> = {};
      extraKeys.forEach(k => { extra[k] = cb[k]; });

      // 기일내역 파싱
      const scheduleRecords = extractScheduleRecords(html);

      // 사진 파싱
      const photos = extractPhotos(html, item.m_code);
      if (item.img_url && !photos.includes(item.img_url)) {
        photos.unshift(item.img_url);
      }

      const record: AuctionRecord = {
        m_code: item.m_code,
        collectedDate: new Date().toISOString(),
        bubwon: item.bubwon,
        caseNum: item.case_num,
        address: item.addr,
        photos: JSON.stringify(photos),
        evalPrice: String(item.eval_price_v),
        soldPrice: String(item.sold_price),
        useType: item.use_type,
        bidDate: item.m_bid_date,
        stateCode: item.m_state_class,
        state: item.m_state_text || item.state,
        auctionType: cb['경매구분'] ?? '',
        landArea: cb['토지'] ?? '',
        buildArea: cb['건물'] ?? '',
        appraisalPrice: cb['감정가'] ?? '',
        minPrice: cb['최저가'] ?? '',
        deposit: cb['보증금'] ?? '',
        saleDate: cb['매각일'] ?? '',
        caseBasicExtra: JSON.stringify(extra),
        scheduleRecords: JSON.stringify(scheduleRecords),
      };

      allResults.push(record);
      newMCodes[item.m_code] = new Date().toISOString();
      totalDetailCollected++;

      console.log(`    ✅ ${item.use_type} | 감정가:${item.eval_price_v.toLocaleString()} | 기일:${scheduleRecords.length}건 | 사진:${photos.length}장`);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    ❌ 실패: ${msg.substring(0, 100)}`);
    }

    await new Promise(r => setTimeout(r, 400));
  }

  currentDate = addDays(currentDate, 1);
}

await browser.close();

console.log(`\n[완료] 신규: ${totalNew}건, 상세수집: ${totalDetailCollected}건, 스킵: ${totalSkipped}건`);

if (!dryRun) {
  Object.assign(state.seenMCodes, newMCodes);
  state.lastRunAt = new Date().toISOString();
  saveState(stateFile, state);

  if (allResults.length > 0) {
    // Parquet 스키마 (전체 UTF8)
    const schemaFields: Record<string, { type: string; compression: string; optional: boolean }> = {};
    for (const key of Object.keys(allResults[0])) {
      schemaFields[key] = { type: 'UTF8', compression: 'GZIP', optional: true };
    }

    const schema = new parquet.ParquetSchema(schemaFields);
    const writer = await parquet.ParquetWriter.openFile(schema, outputFile);
    for (const row of allResults) {
      await writer.appendRow(row as unknown as Record<string, string>);
    }
    await writer.close();
    console.log(`[저장] ${outputFile} (${allResults.length}건, Parquet/GZIP)`);
  }

  const metaFile = outputFile.replace(/\.parquet$/, '.meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({
    collectedAt: new Date().toISOString(),
    startDate, endDate,
    total: totalDetailCollected,
    newItems: totalNew,
    skippedItems: totalSkipped,
  }, null, 2));
  console.log(`[저장] ${metaFile} (메타)`);
} else {
  console.log('[dry-run] 저장 생략');
}

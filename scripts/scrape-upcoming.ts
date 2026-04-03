/**
 * 매각예정 물건 스크래퍼
 * https://www.courtauction.go.kr/pgj/ui/pgj100/PGJ157M00.xml
 *
 * 전략:
 *  1. 법원별 검색 → searchControllerMain.on API 인터셉트 → 리스트 수집
 *  2. 물건별 소재지 A 태그 클릭 → 상세 페이지 DOM 파싱
 *  3. 수집 항목: 물건기본정보, 기일내역, 목록내역, 감정평가요항표
 *  4. 현황조사서: btn_curstExmndcTop 클릭 → selectCurstExmndc.on API
 *  5. 감정평가서: btn_aeeWevl1 클릭 → selectAeeWevlInfo.on API
 *
 * 실행:
 *  node --experimental-strip-types scripts/scrape-upcoming.ts [옵션]
 * 옵션:
 *  --court  서울중앙지방법원  수집할 법원 (기본: 서울중앙지방법원)
 *  --limit  1               수집할 물건 수 (기본: 1, 전체: 0)
 *  --output /tmp/out.json   출력 경로
 *  --dry-run                파일 저장 없이 콘솔 출력만
 */

import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// ── 법원 코드 (select option value) ──
const COURT_NAMES = [
  '서울중앙지방법원', '서울동부지방법원', '서울남부지방법원',
  '서울북부지방법원', '서울서부지방법원', '의정부지방법원',
  '인천지방법원', '수원지방법원', '춘천지방법원', '대전지방법원',
  '청주지방법원', '대구지방법원', '부산지방법원', '울산지방법원',
  '창원지방법원', '광주지방법원', '전주지방법원', '제주지방법원',
];

// ── 타입 ──
interface ListItem {
  docid: string;
  boCd: string;
  saNo: string;
  maemulSer: string | number;
  mokmulSer: string | number;
  srnSaNo: string;
  jiwonNm: string;
  maeGiil: string;
  gamevalAmt: string | number;
  notifyMinmaePrice1: string | number;
  notifyMinmaePriceRate1: string | number;
  yuchalCnt: string | number;
  dspslUsgNm: string;
  printSt: string;
  srchHjguRdCd: string;
  jpDeptNm: string;
  maePlace: string;
  hjguSido: string;
  hjguSigu: string;
  hjguDong: string;
  pjbBuldList: string;
}

interface DateRecord {
  date: string;
  type: string;
  place: string;
  minPrice: string;
  result: string;
}

interface PropertyRecord {
  no: string;
  category: string;
  detail: string;
}

// 현황조사서 임차인 정보
interface LeaseTenant {
  name: string;         // 임차인명
  address: string;      // 소재지
  useType: string;      // 임대 용도 코드
  moveInDate: string;   // 전입일
  depositAmount: string; // 보증금
  leasePart: string;    // 임차 부분
}

interface HwangwangData {
  surveyDate: string;       // 조사일시
  occupancyRelation: string; // 점유관계 요약 텍스트
  occupancyDetail: string;   // 현황 점유 상세 내용
  tenants: LeaseTenant[];    // 임차인 목록
}

interface GamjeongData {
  appraisalNo: string;     // 감정평가서 번호
  appraiserName: string;   // 감정평가사명
  appraisalDate: string;   // 감정일
  reportDate: string;      // 작성일
  opinion: string;         // 감정 의견
}

interface DetailData {
  // 기본 정보 (리스트에서 수집)
  docid: string;
  caseNumber: string;
  courtName: string;
  department: string;
  propertyNo: number;
  propertyType: string;
  address: string;
  dongCode: string | null;
  areaSqm: number | null;
  appraisedValue: number;
  minBidPrice: number;
  minBidRate: number;
  failedBids: number;
  auctionDate: string;
  auctionPlace: string;
  sido: string;
  sigu: string;
  dong: string;
  // 상세 페이지에서 수집
  caseAcceptDate: string;
  auctionStartDate: string;
  dividendDeadline: string;
  claimAmount: string;
  dateRecords: DateRecord[];
  propertyRecords: PropertyRecord[];
  appraisalSummary: string;
  photos: string[];
  // 현황조사서 / 감정평가서
  hwangwang: HwangwangData | null;
  gamjeong: GamjeongData | null;
  collectedAt: string;
}

// ── 유틸 ──
function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function parseArea(pjbBuldList: string): number | null {
  const m = pjbBuldList?.match(/(\d+\.?\d*)㎡/);
  return m ? parseFloat(m[1]) : null;
}

// ── 스크래퍼 ──
class UpcomingAuctionScraper {
  private page!: Page;
  private browser!: Browser;

  async init(): Promise<void> {
    console.log('[브라우저] 스텔스 초기화...');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080', '--lang=ko-KR',
      ],
    });
    const ctx = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as Record<string, unknown>).chrome = { runtime: {} };
    });
    this.page = await ctx.newPage();
  }

  /** 매각예정 페이지 로드 + 법원 선택 + 검색 */
  async searchCourt(courtName: string): Promise<ListItem[]> {
    console.log(`\n[검색] ${courtName}...`);

    await this.page.goto(
      'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ157M00.xml',
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    await delay(1500);

    // 법원 선택
    await this.page.selectOption(
      '#mf_wfm_mainFrame_sbx_dspslSchdGdsCortOfc',
      courtName
    );
    await delay(500);

    // 날짜 범위 확인 (기본값 사용)
    const startDate = await this.page.inputValue('#mf_wfm_mainFrame_cal_dspslSchdGdsPerdStr_input');
    const endDate = await this.page.inputValue('#mf_wfm_mainFrame_cal_dspslSchdGdsPerdEnd_input');
    console.log(`    기간: ${startDate} ~ ${endDate}`);

    // searchControllerMain.on 응답 인터셉트
    let listData: ListItem[] = [];
    const handler = async (res: import('playwright').Response) => {
      if (res.url().includes('searchControllerMain.on')) {
        try {
          const text = await res.text();
          const json = JSON.parse(text);
          const items = json.data?.dlt_srchResult || [];
          const total = json.data?.dma_pageInfo?.totalCnt || 0;
          listData = items;
          console.log(`    총 ${total}건 수신 ${items.length}건 (ipcheck:${json.data?.ipcheck})`);
        } catch (e) {
          console.log('    리스트 파싱 오류:', e);
        }
      }
    };

    this.page.on('response', handler);
    await this.page.click('#mf_wfm_mainFrame_btn_dspslSchdGdsSrch');
    await delay(7000);
    this.page.off('response', handler);

    return listData;
  }

  /** 물건 상세 페이지 수집 (소재지 A 태그 클릭) */
  async collectDetail(item: ListItem, index: number): Promise<DetailData> {
    console.log(`\n  [${index}] ${item.srnSaNo} 상세 수집...`);

    // 소재지 링크 클릭 (address 텍스트 포함 A 태그)
    const addressText = item.printSt.split('\n')[0].trim();
    const shortAddr = addressText.split('(')[0].trim(); // 괄호 이전 부분

    try {
      // 소재지 A 태그 클릭 (주소 텍스트로 찾기)
      const addrLocator = this.page.locator('a').filter({
        hasText: shortAddr.slice(0, 15),
      }).first();
      await addrLocator.waitFor({ timeout: 5000 });
      await addrLocator.click();
      await delay(4000);
    } catch {
      // 대체: 사건번호 텍스트 포함 행의 첫 번째 A 태그
      try {
        await this.page.evaluate((srnSaNo) => {
          const tds = Array.from(document.querySelectorAll('td, div'));
          for (const td of tds) {
            if (td.textContent?.includes(srnSaNo)) {
              const a = td.querySelector('a') || (td.tagName === 'A' ? td : null);
              if (a) { (a as HTMLElement).click(); return; }
            }
          }
        }, item.srnSaNo);
        await delay(4000);
      } catch (e2) {
        console.log(`    클릭 실패: ${e2}`);
      }
    }

    // 상세 DOM 파싱
    const detail = await this.page.evaluate(() => {
      // 테이블 파싱 헬퍼
      const parseTable = (captionText: string): Record<string, string> => {
        const tables = Array.from(document.querySelectorAll('table'));
        const tbl = tables.find(t =>
          t.querySelector('caption')?.textContent?.includes(captionText)
        );
        if (!tbl) return {};
        const result: Record<string, string> = {};
        tbl.querySelectorAll('tr').forEach(tr => {
          const ths = Array.from(tr.querySelectorAll('th')).map(t => t.textContent?.trim() || '');
          const tds = Array.from(tr.querySelectorAll('td')).map(t => t.textContent?.trim() || '');
          ths.forEach((th, i) => { if (th && tds[i]) result[th] = tds[i]; });
        });
        return result;
      };

      // 기일내역 - caption "기일" 포함 테이블, 날짜 패턴인 행만
      const dateRecords: Array<{date: string; type: string; place: string; minPrice: string; result: string}> = [];
      const dateTables = Array.from(document.querySelectorAll('table')).filter(t =>
        t.querySelector('caption')?.textContent?.includes('기일') &&
        !t.querySelector('caption')?.textContent?.includes('물건번호')
      );
      dateTables.forEach(tbl => {
        tbl.querySelectorAll('tbody tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          // 날짜 패턴 (2026.xx.xx) 포함된 행만 수집
          if (cells.length >= 3 && /^\d{4}\.\d{2}\.\d{2}/.test(cells[0])) {
            dateRecords.push({
              date: cells[0] || '',
              type: cells[1] || '',
              place: cells[2] || '',
              minPrice: cells[3] || '',
              result: cells[4] || '',
            });
          }
        });
      });

      // 목록내역
      const propRecords: Array<{no: string; category: string; detail: string}> = [];
      const propTables = Array.from(document.querySelectorAll('table')).filter(t =>
        t.querySelector('caption')?.textContent?.includes('목록')
      );
      propTables.forEach(tbl => {
        tbl.querySelectorAll('tbody tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          if (cells.length >= 2) {
            propRecords.push({ no: cells[0] || '', category: cells[1] || '', detail: cells[2] || '' });
          }
        });
      });

      // 물건기본정보
      const basicInfo = parseTable('사건번호,물건번호,물건종류');

      // 사건정보 (접수일 등)
      const caseInfo = parseTable('사건접수,경매개시일');

      // 감정평가요항표 요약 텍스트 - innerText에서 직접 추출
      let appraisalSummary = '';
      const fullText = document.body.innerText;
      const appraisalIdx = fullText.indexOf('감정평가요항표 요약');
      if (appraisalIdx >= 0) {
        // 다음 주요 섹션("목록내역"이나 "기일내역") 이전까지
        const endMarkers = ['제공된 정보가', '법원경매정보 홈페이지', '★ 참고사항'];
        let endIdx = fullText.length;
        for (const marker of endMarkers) {
          const idx = fullText.indexOf(marker, appraisalIdx);
          if (idx > 0 && idx < endIdx) endIdx = idx;
        }
        appraisalSummary = fullText.slice(appraisalIdx, Math.min(appraisalIdx + 4000, endIdx)).trim();
      }

      // 물건 사진 (img 태그)
      const photos = Array.from(document.querySelectorAll('img[src*="photo"], img[src*="Photo"], img[src*="img"]'))
        .map(img => (img as HTMLImageElement).src)
        .filter(src => src.includes('http') && !src.includes('icon') && !src.includes('btn'));

      return { basicInfo, caseInfo, dateRecords, propRecords, appraisalSummary, photos };
    });

    const result: DetailData = {
      docid: item.docid,
      caseNumber: item.srnSaNo,
      courtName: item.jiwonNm,
      department: item.jpDeptNm,
      propertyNo: Number(item.maemulSer),
      propertyType: item.dspslUsgNm,
      address: item.printSt,
      dongCode: item.srchHjguRdCd && /^\d{10}$/.test(item.srchHjguRdCd) ? item.srchHjguRdCd : null,
      areaSqm: parseArea(item.pjbBuldList),
      appraisedValue: Number(item.gamevalAmt),
      minBidPrice: Number(item.notifyMinmaePrice1),
      minBidRate: Number(item.notifyMinmaePriceRate1),
      failedBids: Number(item.yuchalCnt),
      auctionDate: item.maeGiil,
      auctionPlace: item.maePlace,
      sido: item.hjguSido,
      sigu: item.hjguSigu,
      dong: item.hjguDong,
      caseAcceptDate: detail.caseInfo['사건접수'] || '',
      auctionStartDate: detail.caseInfo['경매개시일'] || '',
      dividendDeadline: detail.caseInfo['배당요구종기'] || '',
      claimAmount: detail.caseInfo['청구금액'] || '',
      dateRecords: detail.dateRecords,
      propertyRecords: detail.propRecords,
      appraisalSummary: detail.appraisalSummary,
      photos: detail.photos,
      hwangwang: null,
      gamjeong: null,
      collectedAt: new Date().toISOString(),
    };

    // ── 현황조사서 / 감정평가서 수집 ──
    try {
      const docs = await this.collectHwangwangGamjeong();
      result.hwangwang = docs.hwangwang;
      result.gamjeong = docs.gamjeong;
      if (docs.hwangwang) console.log(`       현황조사서: 임차인 ${docs.hwangwang.tenants.length}명`);
      if (docs.gamjeong) console.log(`       감정평가서: ${docs.gamjeong.appraisalNo} (${docs.gamjeong.appraiserName})`);
    } catch (e) {
      console.log(`    현황/감정 수집 실패: ${e}`);
    }

    return result;
  }

  /** 현황조사서 + 감정평가서 수집 (버튼 클릭 → API 인터셉트) */
  async collectHwangwangGamjeong(): Promise<{ hwangwang: HwangwangData | null; gamjeong: GamjeongData | null }> {
    let hwangwangRaw: Record<string, unknown> | null = null;
    let gamjeongRaw: Record<string, unknown> | null = null;

    // API 응답 인터셉터 설정
    const handler = async (res: import('playwright').Response) => {
      const url = res.url();
      if (url.includes('selectCurstExmndc.on')) {
        try {
          const json = await res.json();
          hwangwangRaw = json?.data ?? null;
        } catch { /* ignore */ }
      } else if (url.includes('selectAeeWevlInfo.on')) {
        try {
          const json = await res.json();
          gamjeongRaw = json?.data ?? null;
        } catch { /* ignore */ }
      }
    };

    this.page.on('response', handler);

    // ── 현황조사서 버튼 클릭 ──
    try {
      const hwangBtn = this.page.locator('#mf_wfm_mainFrame_btn_curstExmndcTop');
      const visible = await hwangBtn.isVisible().catch(() => false);
      if (visible) {
        await hwangBtn.click();
        await delay(3000); // API 응답 대기
      }
    } catch (e) {
      console.log(`    현황조사서 버튼 클릭 실패: ${e}`);
    }

    // ── 감정평가서 버튼 클릭 ──
    try {
      const gamBtn = this.page.locator('#mf_wfm_mainFrame_btn_aeeWevl1');
      const visible = await gamBtn.isVisible().catch(() => false);
      if (visible) {
        await gamBtn.click();
        await delay(3000); // API 응답 대기
      }
    } catch (e) {
      console.log(`    감정평가서 버튼 클릭 실패: ${e}`);
    }

    this.page.off('response', handler);

    // ── 현황조사서 파싱 ──
    let hwangwang: HwangwangData | null = null;
    if (hwangwangRaw) {
      const mng = (hwangwangRaw as Record<string, unknown>).dma_curstExmnMngInf as Record<string, unknown> | undefined;
      const rletList = ((hwangwangRaw as Record<string, unknown>).dlt_ordTsRlet as Array<Record<string, unknown>>) ?? [];
      const lserList = ((hwangwangRaw as Record<string, unknown>).dlt_ordTsLserLtn as Array<Record<string, unknown>>) ?? [];

      const occupancyDetail = rletList
        .map((r) => String(r.gdsPossCtt ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join('\n---\n');

      const tenants: LeaseTenant[] = lserList.map((t) => ({
        name: String(t.intrpsNm ?? ''),
        address: String(t.printSt ?? ''),
        useType: String(t.auctnLesUsgCd ?? ''),
        moveInDate: String(t.mvinDtlCtt ?? ''),
        depositAmount: String(t.mmrntAmtDts ?? ''),
        leasePart: String(t.lesPartCtt ?? ''),
      }));

      hwangwang = {
        surveyDate: String(mng?.exmnDtDts ?? ''),
        occupancyRelation: String(mng?.printRltnDts ?? ''),
        occupancyDetail,
        tenants,
      };
    }

    // ── 감정평가서 파싱 ──
    let gamjeong: GamjeongData | null = null;
    if (gamjeongRaw) {
      const inf = (gamjeongRaw as Record<string, unknown>).dma_ordTsIndvdAeeWevlInf as Record<string, unknown> | undefined;
      if (inf) {
        gamjeong = {
          appraisalNo: String(inf.aeeWevlNo ?? ''),
          appraiserName: String(inf.aeeEvlExamrNm ?? ''),
          appraisalDate: String(inf.exmnYmd ?? ''),
          reportDate: String(inf.wrtYmd ?? ''),
          opinion: String(inf.fstmEvlDcsnOponCtt ?? ''),
        };
      }
    }

    return { hwangwang, gamjeong };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

// ── CLI ──
function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      result[key] = args[i + 1]?.startsWith('--') ? 'true' : (args[++i] ?? 'true');
    }
  }
  return result;
}

const args = parseArgs();
const courtName = args['court'] || '서울중앙지방법원';
const limit = parseInt(args['limit'] ?? '1');
const outputPath = args['output'] || '/tmp/upcoming-single.json';
const dryRun = args['dry-run'] === 'true';

const scraper = new UpcomingAuctionScraper();
try {
  await scraper.init();

  // 1. 리스트 수집
  const listItems = await scraper.searchCourt(courtName);
  if (listItems.length === 0) {
    console.log('수집된 물건 없음');
    process.exit(0);
  }

  const targets = limit > 0 ? listItems.slice(0, limit) : listItems;
  console.log(`\n[상세 수집] ${targets.length}건 시작...`);

  // 2. 각 물건 상세 수집
  const results: DetailData[] = [];
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i] as ListItem;
    try {
      const detail = await scraper.collectDetail(item, i + 1);
      results.push(detail);

      // 수집 요약 출력
      console.log(`    ✅ ${detail.caseNumber} | ${detail.propertyType} | 감정가:${(detail.appraisedValue/1e8).toFixed(1)}억 | 매각기일:${detail.auctionDate}`);
      console.log(`       주소: ${detail.address}`);
      console.log(`       기일내역: ${detail.dateRecords.length}건, 목록내역: ${detail.propertyRecords.length}건`);
      if (detail.appraisalSummary) {
        console.log(`       감정평가 요약: ${detail.appraisalSummary.slice(0, 100)}...`);
      }

      await delay(2000);
    } catch (e) {
      console.log(`    ❌ ${item.srnSaNo} 실패: ${e}`);
    }
  }

  // 3. 저장
  const output = {
    meta: {
      court: courtName,
      collectedAt: new Date().toISOString(),
      total: results.length,
    },
    results,
  };

  if (!dryRun) {
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n[저장] ${outputPath} (${results.length}건)`);
  } else {
    console.log('\n[dry-run] 결과:');
    console.log(JSON.stringify(output, null, 2).slice(0, 2000));
  }
} finally {
  await scraper.close();
}

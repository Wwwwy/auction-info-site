/**
 * 매각예정 물건 스크래퍼
 * courtauction.go.kr 에서 현재 매각 예정인 경매물건 수집
 *
 * 전략: searchControllerMain.on 엔드포인트 사용 (낙찰결과 API와 별개)
 *   - 사건번호 quick search 로 세션 수립 후 응답 인터셉트
 *   - 오늘 이후 maeGiil(매각기일)인 물건만 필터링
 *
 * 실행:
 *   node --experimental-strip-types scripts/scrape-upcoming.ts [옵션]
 * 옵션:
 *   --courts 서울중앙,인천   특정 법원만 (기본: 전체)
 *   --output /tmp/out.json  출력 경로 (기본: /tmp/upcoming-auctions.json)
 *   --dry-run               파싱 결과만 출력, 파일 저장 안함
 */

import { chromium, type Browser, type Page, type Response } from 'playwright';
import { writeFileSync } from 'fs';

// ── 법원 코드 ──
const COURT_CODES: Record<string, string> = {
  '서울중앙': '0101',
  '서울동부': '0102',
  '서울남부': '0103',
  '서울북부': '0104',
  '서울서부': '0105',
  '인천': '0201',
  '수원': '0301',
  '성남': '0302',
  '의정부': '0303',
  '춘천': '0401',
  '대전': '0501',
  '청주': '0502',
  '대구': '0601',
  '부산': '0701',
  '울산': '0702',
  '창원': '0703',
  '광주': '0801',
  '전주': '0802',
  '제주': '0901',
  '부천': '1001',
  '평택': '1002',
  '안양': '1003',
  '안산': '1004',
};

// ── 타입 ──
interface RawItem {
  srnSaNo?: string;
  jiwonNm?: string;
  maeGiil?: string;
  gamevalAmt?: string;
  maeAmt?: string;
  mulStatcd?: string;
  dspslUsgNm?: string;
  printSt?: string;
  srchHjguRdCd?: string;
  yuchalCnt?: string;
  pjbBuldList?: string;
  [key: string]: unknown;
}

interface UpcomingItem {
  caseNumber: string;
  courtName: string;
  auctionDate: string;
  propertyType: string;
  appraisedValue: number;
  failedBids: number;
  status: string;
  address: string | null;
  dongCode: string | null;
  areaSqm: number | null;
}

// ── 파서 ──
function parseItem(raw: RawItem): UpcomingItem {
  const areaMatch = raw.pjbBuldList?.match(/(\d+\.?\d*)㎡/);
  return {
    caseNumber: raw.srnSaNo || '',
    courtName: raw.jiwonNm || '',
    auctionDate: raw.maeGiil || '',
    propertyType: raw.dspslUsgNm || '',
    appraisedValue: Number(raw.gamevalAmt || 0),
    failedBids: Number(raw.yuchalCnt || 0),
    status: raw.mulStatcd || '',
    address: raw.printSt || null,
    dongCode: raw.srchHjguRdCd && /^\d{10}$/.test(raw.srchHjguRdCd)
      ? raw.srchHjguRdCd
      : null,
    areaSqm: areaMatch ? parseFloat(areaMatch[1]) : null,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ── 스크래퍼 ──
class UpcomingAuctionScraper {
  private page: Page | null = null;
  private browser: Browser | null = null;
  private collectedData: UpcomingItem[] = [];
  private seenCases = new Set<string>();

  private stats = { searches: 0, total: 0, upcoming: 0, errors: 0 };

  async initialize(): Promise<void> {
    console.log('[1] 브라우저 초기화 (스텔스 모드)...');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--lang=ko-KR',
      ],
    });

    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      extraHTTPHeaders: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
      (window as Record<string, unknown>).chrome = { runtime: {} };
      delete (window as Record<string, unknown>).__playwright;
    });

    this.page = await context.newPage();

    console.log('[2] 메인 페이지 로드 (세션 획득)...');
    await this.page.goto('https://www.courtauction.go.kr/pgj/index.on', {
      waitUntil: 'networkidle',
      timeout: 40000,
    });
    await delay(2000 + Math.random() * 1000);

    const cookies = await context.cookies();
    console.log(`    쿠키: ${cookies.map(c => c.name).join(', ')}`);
  }

  async searchByTerm(term: string): Promise<void> {
    if (!this.page) throw new Error('page not initialized');

    this.stats.searches++;
    console.log(`\n[검색] "${term}"...`);

    let captured: RawItem[] = [];

    const handler = async (res: Response) => {
      if (res.url().includes('searchControllerMain.on')) {
        try {
          const text = await res.text();
          console.log(`    raw(100): ${text.slice(0, 100)}`);
          const json = JSON.parse(text);
          const items = json.data?.dlt_srchResult || [];
          const total = json.data?.dma_pageInfo?.totalCnt || 0;
          console.log(`    totalCnt: ${total} | 수신: ${items.length}건`);
          captured = items;
        } catch (e) {
          console.log(`    파싱 실패: ${e}`);
        }
      }
    };

    this.page.on('response', handler);

    try {
      await this.page.locator('#mf_ibx_auctnTrmCtt').fill(term);
      await delay(300);
      await this.page.locator('#mf_btn_quickSearchGds').click();
      await delay(6000);
    } finally {
      this.page.off('response', handler);
    }

    const todayStr = today();
    let newCount = 0;

    for (const raw of captured) {
      this.stats.total++;
      const maeGiil = String(raw.maeGiil || '');
      // 미래 매각기일 or 기일 없는 진행중 물건
      if (maeGiil && maeGiil < todayStr) continue;
      this.stats.upcoming++;

      const item = parseItem(raw as RawItem);
      if (!item.caseNumber || this.seenCases.has(item.caseNumber)) continue;

      this.seenCases.add(item.caseNumber);
      this.collectedData.push(item);
      newCount++;
    }

    console.log(`    오늘 이후: ${newCount}건 수집 (누적: ${this.collectedData.length})`);
  }

  async run(options: {
    courts?: string[];
    output?: string;
    dryRun?: boolean;
  } = {}): Promise<void> {
    const outputPath = options.output || '/tmp/upcoming-auctions.json';

    await this.initialize();

    // 검색 전략:
    // quicksearch("2026타경") → searchControllerMain.on 응답 인터셉트
    // 연도별 검색 → 각 페이지 수집 → 오늘 이후 maeGiil 필터
    // ※ quick search는 첫 페이지만 반환하므로 여러 검색어 조합
    const currentYear = new Date().getFullYear();
    const searchTerms: string[] = [
      `${currentYear}타경`,     // 올해 전체
      `${currentYear - 1}타경`, // 전년도 (미완료 사건)
    ];

    const targetCourts = options.courts
      ? options.courts.filter(c => COURT_CODES[c])
      : Object.keys(COURT_CODES);

    console.log(`\n[3] 총 ${searchTerms.length}개 검색어로 수집 시작`);
    console.log(`    기준일(오늘): ${today()}`);
    console.log(`    대상 법원: ${targetCourts.join(', ')}`);

    for (const term of searchTerms) {
      try {
        await this.searchByTerm(term);
        await delay(3000 + Math.random() * 2000);
      } catch (e) {
        this.stats.errors++;
        console.log(`    [오류] ${term}: ${e}`);
      }
    }

    console.log(`\n[완료] 총 ${this.collectedData.length}건 수집`);
    console.log(`  검색 횟수: ${this.stats.searches}`);
    console.log(`  전체 수신: ${this.stats.total}`);
    console.log(`  오늘 이후: ${this.stats.upcoming}`);
    console.log(`  오류: ${this.stats.errors}`);

    if (!options.dryRun) {
      const out = {
        meta: {
          collectedAt: new Date().toISOString(),
          today: today(),
          totalItems: this.collectedData.length,
          courts: targetCourts,
        },
        results: this.collectedData,
      };
      writeFileSync(outputPath, JSON.stringify(out, null, 2));
      console.log(`[저장] ${outputPath} (${this.collectedData.length}건)`);
    } else {
      console.log('[dry-run] 샘플 5건:');
      this.collectedData.slice(0, 5).forEach((item, i) => {
        console.log(`  [${i + 1}] ${item.caseNumber} | ${item.auctionDate} | ${item.propertyType} | 감정가: ${(item.appraisedValue / 1e8).toFixed(1)}억`);
      });
    }
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
  }
}

// ── CLI ──
function parseArgs(): Record<string, string | string[]> {
  const args = process.argv.slice(2);
  const result: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      result[key] = args[i + 1]?.startsWith('--') ? 'true' : (args[++i] ?? 'true');
    }
  }
  return result;
}

const args = parseArgs();
const scraper = new UpcomingAuctionScraper();

try {
  await scraper.run({
    courts: args['courts'] ? String(args['courts']).split(',').map(s => s.trim()) : undefined,
    output: args['output'] ? String(args['output']) : undefined,
    dryRun: args['dry-run'] === 'true',
  });
} finally {
  await scraper.close();
}

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
 *  --court      서울중앙지방법원  특정 법원 (기본: 서울중앙지방법원)
 *  --all-courts                  전체 18개 법원 순환
 *  --limit      1                수집할 물건 수 (기본: 1, 전체: 0)
 *  --output     /tmp/out.json    출력 경로
 *  --state-file  /tmp/state.json  증분 수집용 state 파일 (이미 수집한 docid 추적)
 *  --dry-run                     파일 저장 없이 콘솔 출력만
 *
 * PDF 수집: 감정평가서 버튼 클릭 시 kapanet 뷰어 탭이 열리고
 *           PDF 응답을 자동으로 인터셉트해 pdfBase64 필드에 저장
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
  viewerUrl: string;       // ca.kapanet.or.kr 뷰어 URL
  pdfUrl: string | null;   // 실제 PDF 다운로드 URL (동적, 뷰어 로드 시 발급)
  pdfBase64: string | null; // PDF 바이너리 (base64), --download-pdf 옵션 시만 수집
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

      // 물건 사진 — gen_pic_{N}_img_reltPic 패턴 (base64 내장)
      // 상세 페이지에서 사진은 data:image/png;base64,... 형식으로 DOM에 직접 포함됨
      const photos: string[] = [];
      for (let n = 0; n < 20; n++) {
        const el = document.getElementById(`mf_wfm_mainFrame_gen_pic_${n}_img_reltPic`) as HTMLImageElement | null;
        if (!el) break; // ID 패턴이 끊기면 종료
        const src = el.src || '';
        if (src.startsWith('data:image/') && src.length > 100) {
          photos.push(src); // base64 전체 포함
        }
      }

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
      if (docs.gamjeong) {
        const g = docs.gamjeong;
        const pdfStatus = g.pdfBase64
          ? `✅ PDF ${Math.round(g.pdfBase64.length * 0.75 / 1024)}KB`
          : (g.pdfUrl ? '🔗 URL만' : '없음');
        console.log(`       감정평가서: ${g.appraisalNo} (${g.appraiserName}) [${pdfStatus}]`);
      }
    } catch (e) {
      console.log(`    현황/감정 수집 실패: ${e}`);
    }

    console.log(`       사진: ${result.photos.length}장`);

    return result;
  }

  /** 현황조사서 + 감정평가서 수집 (버튼 클릭 → API 인터셉트) */
  async collectHwangwangGamjeong(): Promise<{ hwangwang: HwangwangData | null; gamjeong: GamjeongData | null }> {
    let hwangwangRaw: Record<string, unknown> | null = null;
    let gamjeongRaw: Record<string, unknown> | null = null;
    let capturedPdfUrl: string | null = null;
    let capturedPdfBytes: Buffer | null = null;

    // API 응답 인터셉터 (현황/감정 JSON)
    const handler = async (res: import('playwright').Response) => {
      const url = res.url();
      if (url.includes('selectCurstExmndc.on')) {
        try { hwangwangRaw = (await res.json())?.data ?? null; } catch { /* ignore */ }
      } else if (url.includes('selectAeeWevlInfo.on')) {
        try { gamjeongRaw = (await res.json())?.data ?? null; } catch { /* ignore */ }
      }
    };

    this.page.on('response', handler);

    // ── 현황조사서 버튼 클릭 ──
    try {
      const hwangBtn = this.page.locator('#mf_wfm_mainFrame_btn_curstExmndcTop');
      const visible = await hwangBtn.isVisible().catch(() => false);
      if (visible) {
        await hwangBtn.click({ timeout: 5000 });
        await delay(3000);
      }
    } catch (e) {
      console.log(`    현황조사서 버튼 클릭 실패: ${e}`);
    }

    // ── 감정평가서 버튼 클릭 → 새 탭에서 PDF URL + 바이너리 캡처 ──
    // Context 레벨 핸들러를 클릭 전에 등록해 새 탭의 PDF 응답도 놓치지 않음
    const pdfHandler = async (res: import('playwright').Response) => {
      const url = res.url();
      if (url.includes('kapanet.or.kr') && url.endsWith('.pdf') && !capturedPdfUrl) {
        capturedPdfUrl = url;
        try { capturedPdfBytes = await res.body(); } catch { /* ignore */ }
      }
    };
    this.page.context().on('response', pdfHandler);

    try {
      const gamBtn = this.page.locator('#mf_wfm_mainFrame_btn_aeeWevl1');
      const visible = await gamBtn.isVisible().catch(() => false);
      if (visible) {
        const newPagePromise = this.page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
        await gamBtn.click({ timeout: 5000 });
        const newTab = await newPagePromise;
        if (newTab) {
          await newTab.waitForLoadState('domcontentloaded').catch(() => null);
          await delay(4000); // PDF 요청 대기
          await newTab.close().catch(() => null);
        } else {
          await delay(4000);
        }
      }
    } catch (e) {
      console.log(`    감정평가서 버튼 클릭 실패: ${e}`);
    }

    this.page.context().off('response', pdfHandler);

    // PDF URL은 잡혔으나 bytes가 없는 경우 — context.request로 직접 다운로드 (쿠키 공유)
    if (capturedPdfUrl && !capturedPdfBytes) {
      try {
        const apiRes = await this.page.context().request.get(capturedPdfUrl, { timeout: 20000 });
        if (apiRes.ok()) {
          capturedPdfBytes = await apiRes.body();
          console.log(`    감정평가서 PDF 다운로드: ${capturedPdfBytes?.length ?? 0} bytes`);
        } else {
          console.log(`    [PDF] 다운로드 실패 status=${apiRes.status()}`);
        }
      } catch (e) {
        console.log(`    [PDF] 다운로드 오류: ${e}`);
      }
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
        // Viewer URL: ca.kapanet.or.kr/view/{cortOfcCd}/{csNo}/{ordTsCnt}/{aeeWevlNo}/{dspslPrcCrtrYmd}
        const cortOfcCd = String(inf.cortOfcCd ?? '').replace(/^B/, ''); // B000210 → 000210
        const csNo = String(inf.csNo ?? '');
        const ordTsCnt = String(inf.ordTsCnt ?? '1');
        const aeeWevlNo = String(inf.aeeWevlNo ?? '');
        const dspslPrcCrtrYmd = String(inf.dspslPrcCrtrYmd ?? '');
        const viewerUrl = `https://ca.kapanet.or.kr/view/${cortOfcCd}/${csNo}/${ordTsCnt}/${aeeWevlNo}/${dspslPrcCrtrYmd}`;

        gamjeong = {
          appraisalNo: aeeWevlNo,
          appraiserName: String(inf.aeeEvlExamrNm ?? ''),
          appraisalDate: String(inf.exmnYmd ?? ''),
          reportDate: dspslPrcCrtrYmd,
          opinion: String(inf.fstmEvlDcsnOponCtt ?? ''),
          viewerUrl,
          pdfUrl: capturedPdfUrl,
          pdfBase64: capturedPdfBytes ? capturedPdfBytes.toString('base64') : null,
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

// ── State 파일 타입 ──
interface StateFile {
  version: number;
  lastRunAt: string;
  // docid → 최초 수집일 (ISO string)
  seenDocIds: Record<string, string>;
}

function loadState(stateFilePath: string | null): StateFile {
  if (!stateFilePath) return { version: 1, lastRunAt: '', seenDocIds: {} };
  if (!existsSync(stateFilePath)) {
    console.log(`[증분] state 파일 없음 (${stateFilePath}) — 전체 수집 모드`);
    return { version: 1, lastRunAt: '', seenDocIds: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as StateFile;
    const count = Object.keys(raw.seenDocIds || {}).length;
    console.log(`[증분] state 로드: ${count}개 docid 이미 수집됨 (마지막 실행: ${raw.lastRunAt})`);
    return raw;
  } catch (e) {
    console.log(`[증분] state 파일 파싱 실패 — 전체 수집 모드: ${e}`);
    return { version: 1, lastRunAt: '', seenDocIds: {} };
  }
}

function saveState(stateFilePath: string, state: StateFile): void {
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  console.log(`[증분] state 저장: ${Object.keys(state.seenDocIds).length}개 docid → ${stateFilePath}`);
}

// ── 단일 법원 수집 (재사용 가능한 함수) ──
async function collectCourt(
  scraper: UpcomingAuctionScraper,
  courtName: string,
  limit: number,
  seenDocIds: Record<string, string>,
  dryRun: boolean,
): Promise<{ results: DetailData[]; newDocIds: Record<string, string> }> {
  const listItems = await scraper.searchCourt(courtName);
  if (listItems.length === 0) {
    console.log(`  [${courtName}] 수집된 물건 없음`);
    return { results: [], newDocIds: {} };
  }

  // 증분 필터: 이미 수집한 docid 제외
  const newItems = listItems.filter(item => !seenDocIds[item.docid]);
  const skippedCount = listItems.length - newItems.length;
  if (skippedCount > 0) {
    console.log(`  [${courtName}] 전체 ${listItems.length}건 중 기수집 ${skippedCount}건 스킵 → 신규 ${newItems.length}건`);
  }

  if (newItems.length === 0) {
    console.log(`  [${courtName}] 신규 물건 없음`);
    return { results: [], newDocIds: {} };
  }

  const targets = limit > 0 ? newItems.slice(0, limit) : newItems;
  console.log(`\n[상세 수집] ${courtName} — ${targets.length}건 시작...`);

  const results: DetailData[] = [];
  const newDocIds: Record<string, string> = {};
  const now = new Date().toISOString();

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i] as ListItem;
    try {
      if (!dryRun) {
        const detail = await scraper.collectDetail(item, i + 1);
        results.push(detail);
        console.log(`    ✅ ${detail.caseNumber} | ${detail.propertyType} | 감정가:${(detail.appraisedValue/1e8).toFixed(1)}억 | 매각기일:${detail.auctionDate}`);
        console.log(`       주소: ${detail.address}`);
        console.log(`       기일내역: ${detail.dateRecords.length}건, 목록내역: ${detail.propertyRecords.length}건`);
        if (detail.appraisalSummary) {
          console.log(`       감정평가 요약: ${detail.appraisalSummary.slice(0, 100)}...`);
        }
        await delay(2000);
      } else {
        console.log(`    [dry] ${item.srnSaNo} | ${item.dspslUsgNm}`);
      }
      // 성공 여부와 무관하게 docid를 수집 완료로 기록
      newDocIds[item.docid] = now;
    } catch (e) {
      console.log(`    ❌ ${item.srnSaNo} 실패: ${e}`);
    }
  }

  return { results, newDocIds };
}

// ── CLI 실행 ──
const args = parseArgs();
const singleCourt = args['court'];
const allCourts = args['all-courts'] === 'true';
const limit = parseInt(args['limit'] ?? '1');
const outputPath = args['output'] || '/tmp/upcoming-single.json';
const stateFilePath = args['state-file'] || null;
const dryRun = args['dry-run'] === 'true';

// 수집 대상 법원 목록 결정
const courtsToScrape: string[] = allCourts
  ? COURT_NAMES
  : [singleCourt || '서울중앙지방법원'];

console.log(`\n=== 매각예정 물건 수집 시작 ===`);
console.log(`법원: ${allCourts ? `전체 ${courtsToScrape.length}개` : courtsToScrape[0]}`);
console.log(`limit: ${limit === 0 ? '전체' : `${limit}건`}, dry-run: ${dryRun}`);
console.log(`state-file: ${stateFilePath || '없음 (전체 수집)'}`);

// State 로드
const state = loadState(stateFilePath);

const allResults: DetailData[] = [];
let totalNewDocIds: Record<string, string> = {};

// 법원별 수집 (각 법원마다 브라우저 재초기화로 메모리 안정화)
for (let ci = 0; ci < courtsToScrape.length; ci++) {
  const courtName = courtsToScrape[ci];
  console.log(`\n[${ci + 1}/${courtsToScrape.length}] ${courtName} 수집 시작...`);

  const scraper = new UpcomingAuctionScraper();
  try {
    await scraper.init();
    const { results, newDocIds } = await collectCourt(
      scraper, courtName, limit, state.seenDocIds, dryRun
    );
    allResults.push(...results);
    Object.assign(totalNewDocIds, newDocIds);
  } catch (e) {
    console.log(`  [${courtName}] 수집 오류: ${e}`);
  } finally {
    await scraper.close();
  }

  // 법원 간 딜레이 (rate limit 방지)
  if (ci < courtsToScrape.length - 1) {
    console.log(`  (다음 법원 전 3초 대기...)`);
    await delay(3000);
  }
}

// State 업데이트 + 저장
const newCount = Object.keys(totalNewDocIds).length;
console.log(`\n[완료] 신규 수집: ${newCount}건, 상세 수집: ${allResults.length}건`);

if (stateFilePath && !dryRun && newCount > 0) {
  Object.assign(state.seenDocIds, totalNewDocIds);
  state.lastRunAt = new Date().toISOString();
  saveState(stateFilePath, state);
}

// 결과 저장
const output = {
  meta: {
    courts: courtsToScrape,
    collectedAt: new Date().toISOString(),
    total: allResults.length,
    newItems: newCount,
    skippedItems: Object.keys(state.seenDocIds).length - newCount,
    mode: allCourts ? 'all-courts' : 'single-court',
    incremental: stateFilePath !== null,
  },
  results: allResults,
};

if (!dryRun) {
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`[저장] ${outputPath} (${allResults.length}건)`);
} else {
  console.log('\n[dry-run] 메타:');
  console.log(JSON.stringify(output.meta, null, 2));
  if (allResults.length > 0) {
    console.log('[dry-run] 첫 번째 결과:');
    console.log(JSON.stringify(allResults[0], null, 2).slice(0, 1000));
  }
}

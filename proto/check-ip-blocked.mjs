/**
 * IP 차단 상태 확인 테스트
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
});
const page = await context.newPage();

console.log('[1] 메인 페이지 로드 (세션 획득)...');
await page.goto('https://www.courtauction.go.kr/pgj/index.on', {
  waitUntil: 'networkidle', timeout: 35000,
});
await page.waitForTimeout(2000);

console.log('[2] API 호출로 IP 차단 상태 확인...');

const result = await page.evaluate(async () => {
  const body = {
    dma_pageInfo: { pageNo: 1, pageSize: 20, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
    dma_srchGdsDtlSrchInfo: {
      statNum: '1',
      pgmId: 'PGJ158M01',
      cortStDvs: '0',
      cortOfcCd: '0101',
      jdbnCd: '',
      csNo: '',
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      auctnGdsStatCd: '',
      lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
      dspslAmtMin: '', dspslAmtMax: '',
      aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      flbdNcntMin: '', flbdNcntMax: '',
      lafjOrderBy: '',
      srchStartMaeGiil: '20250301',
      srchEndMaeGiil: '20250331',
    }
  };

  try {
    const res = await fetch('/pgj/pgjsearch/selectDspslSchdRsltSrch.on', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e) {
    return { error: e.message };
  }
});

console.log(`  Status: ${result.status || result.error}`);

if (result.body) {
  try {
    const json = JSON.parse(result.body);
    const message = json.message || 'none';
    const total = json.data?.dma_pageInfo?.totalCnt || 0;
    const items = json.data?.dlt_srchResult?.length || 0;

    console.log(`  Message: ${message}`);
    console.log(`  Total: ${total}`);
    console.log(`  Items: ${items}`);

    if (message.includes('차단') || message.includes('비정상')) {
      console.log('\n❌ 여전히 IP 차단 상태입니다.');
    } else if (items > 0) {
      console.log('\n✅ IP 차단이 해제되었습니다! 데이터 수집 가능.');
      console.log(`  샘플: ${items}건 수신`);
    } else if (total === 0 && items === 0) {
      console.log('\n⚠️ 차단은 해제되었으나 데이터가 없습니다 (기간 문제일 수 있음).');
    } else {
      console.log('\n✅ API 응답 정상.');
    }
  } catch (e) {
    console.log(`  Raw: ${result.body.slice(0, 200)}`);
  }
}

await browser.close();
console.log('\n[완료]');

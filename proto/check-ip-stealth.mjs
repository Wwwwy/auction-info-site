/**
 * IP 차단 상태 확인 - 스텔스 모드
 * headless 브라우저 감지 우회 + 실제 브라우저 동작 시뮬레이션
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1920,1080',
    '--start-maximized',
    '--lang=ko-KR',
  ],
});

const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  extraHTTPHeaders: {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
  },
});

// navigator.webdriver 제거 (headless 감지 우회)
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  window.chrome = { runtime: {} };
  delete window.__playwright;
  delete window.__pw_manual;
});

const page = await context.newPage();

// 요청 헤더 인터셉트 - API 호출 시 적절한 헤더 추가
await page.route('**/*.on', async (route, request) => {
  const headers = {
    ...request.headers(),
    'Referer': 'https://www.courtauction.go.kr/',
    'Origin': 'https://www.courtauction.go.kr',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'X-Requested-With': 'XMLHttpRequest',
  };
  await route.continue({ headers });
});

console.log('[1] 메인 페이지 로드 (세션 + 쿠키 획득)...');
await page.goto('https://www.courtauction.go.kr/pgj/index.on', {
  waitUntil: 'networkidle',
  timeout: 35000,
});

// 실제 사용자처럼 잠깐 대기
await page.waitForTimeout(2000 + Math.random() * 1000);

// 스크롤 시뮬레이션 (실제 사용자 동작)
await page.evaluate(() => window.scrollTo(0, 200));
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1000 + Math.random() * 500);

// 현재 쿠키 확인
const cookies = await context.cookies();
console.log(`  쿠키 획득: ${cookies.map(c => c.name).join(', ')}`);

// 낙찰결과 메뉴로 실제 네비게이션 시도
console.log('[2] 낙찰결과 탭 네비게이션 시도...');
try {
  // 낙찰결과 링크 탐색
  const navLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, li'));
    return links
      .filter(el => el.textContent?.includes('낙찰') || el.textContent?.includes('매각결과'))
      .map(el => ({ text: el.textContent?.trim(), href: el.getAttribute('href') || '' }))
      .slice(0, 5);
  });
  console.log(`  네비게이션 메뉴: ${JSON.stringify(navLinks)}`);
} catch (e) {
  console.log(`  메뉴 탐색 실패: ${e.message}`);
}

await page.waitForTimeout(1500);

console.log('[3] 낙찰결과 API 호출...');
const result = await page.evaluate(async () => {
  const body = {
    dma_pageInfo: {
      pageNo: 1,
      pageSize: 20,
      bfPageNo: '',
      startRowNo: '',
      totalCnt: '',
      totalYn: 'Y',
      groupTotalCount: '',
    },
    dma_srchGdsDtlSrchInfo: {
      statNum: '1',
      pgmId: 'PGJ158M01',
      cortStDvs: '0',
      cortOfcCd: '0101',
      jdbnCd: '',
      csNo: '',
      rprsAdongSdCd: '',
      rprsAdongSggCd: '',
      rprsAdongEmdCd: '',
      rdnmSdCd: '',
      rdnmSggCd: '',
      rdnmNo: '',
      auctnGdsStatCd: '',
      lclDspslGdsLstUsgCd: '',
      mclDspslGdsLstUsgCd: '',
      sclDspslGdsLstUsgCd: '',
      dspslAmtMin: '',
      dspslAmtMax: '',
      aeeEvlAmtMin: '',
      aeeEvlAmtMax: '',
      flbdNcntMin: '',
      flbdNcntMax: '',
      lafjOrderBy: '',
      srchStartMaeGiil: '20250101',
      srchEndMaeGiil: '20250331',
    },
  };

  try {
    const res = await fetch('/pgj/pgjsearch/selectDspslSchdRsltSrch.on', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
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
  const preview = result.body.slice(0, 300);
  console.log(`  Raw (300자): ${preview}`);

  try {
    const json = JSON.parse(result.body);
    const message = json.message || json.msg || 'none';
    const total = json.data?.dma_pageInfo?.totalCnt || 0;
    const items = json.data?.dlt_srchResult?.length || 0;

    console.log(`  Message: ${message}`);
    console.log(`  Total: ${total}`);
    console.log(`  Items: ${items}`);

    if (message.includes('차단') || message.includes('비정상') || message.includes('block')) {
      console.log('\n❌ 여전히 IP 차단 상태입니다.');
      process.exit(1);
    } else if (items > 0) {
      console.log('\n✅ IP 차단 해제! 데이터 수집 가능.');
      console.log(`  샘플 ${items}건 수신`);
    } else if (result.status === 200 && total === 0) {
      console.log('\n⚠️ 응답은 왔으나 데이터 없음 (기간/조건 문제일 수 있음).');
    } else {
      console.log('\n? 알 수 없는 응답 상태.');
    }
  } catch (e) {
    console.log(`  JSON 파싱 실패: ${e.message}`);
    if (result.body.includes('차단') || result.body.includes('비정상')) {
      console.log('\n❌ 차단 메시지 감지.');
      process.exit(1);
    }
  }
}

await browser.close();
console.log('\n[완료]');

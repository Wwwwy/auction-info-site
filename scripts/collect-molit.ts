/**
 * 국토부 실거래가 수집 스크립트
 * https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev
 *
 * 지원 데이터 유형:
 *  - apt-trade    : 아파트 매매 실거래가
 *  - apt-rent     : 아파트 전월세
 *  - offi-trade   : 오피스텔 매매
 *  - offi-rent    : 오피스텔 전월세
 *  - rh-trade     : 연립다세대 매매
 *  - sh-trade     : 단독다가구 매매
 *
 * 실행:
 *  node --experimental-strip-types scripts/collect-molit.ts [옵션]
 * 옵션:
 *  --type       apt-trade          데이터 유형 (기본: apt-trade)
 *  --ym         202503             수집 연월 YYYYMM (기본: 전월)
 *  --ym-range   202501-202503      연월 범위 (--ym 대신 사용)
 *  --regions    전국|서울|경기|...  수집 지역 (기본: 전국)
 *  --output     /tmp/molit.json    출력 경로
 *  --state-file /tmp/state.json    증분 수집용 state (중복 방지)
 *  --dry-run                       API 호출 없이 파라미터만 출력
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';

// ── API 엔드포인트 ──
const API_BASE = 'https://apis.data.go.kr/1613000';

const ENDPOINTS: Record<string, string> = {
  'apt-trade':  `${API_BASE}/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev`,
  'apt-rent':   `${API_BASE}/RTMSDataSvcAptRentDev/getRTMSDataSvcAptRentDev`,
  'offi-trade': `${API_BASE}/RTMSOBJSvc/getRTMSDataSvcOffiTrade`,
  'offi-rent':  `${API_BASE}/RTMSOBJSvc/getRTMSDataSvcOffiRent`,
  'rh-trade':   `${API_BASE}/RTMSOBJSvc/getRTMSDataSvcRHTrade`,
  'sh-trade':   `${API_BASE}/RTMSOBJSvc/getRTMSDataSvcSHTrade`,
};

// ── 시군구 코드 (법정동 앞 5자리) ──
// 출처: 행정안전부 법정동코드
const SIGUNGU_CODES: Record<string, string[]> = {
  '서울': [
    '11110','11140','11170','11200','11215','11230','11260','11290',
    '11305','11320','11350','11380','11410','11440','11470','11500',
    '11530','11545','11560','11590','11620','11650','11680','11710','11740',
  ],
  '부산': [
    '26110','26140','26170','26200','26230','26260','26290','26320',
    '26350','26380','26410','26440','26470','26500','26530','26710',
  ],
  '대구': [
    '27110','27140','27170','27200','27230','27260','27290','27710',
  ],
  '인천': [
    '28110','28140','28177','28185','28200','28237','28245','28260','28710','28720',
  ],
  '광주': ['29110','29140','29155','29170','29200'],
  '대전': ['30110','30140','30170','30200','30230'],
  '울산': ['31110','31140','31170','31200','31710'],
  '세종': ['36110'],
  '경기': [
    '41111','41113','41115','41117','41119','41121','41131','41133',
    '41135','41150','41171','41173','41175','41190','41210','41220',
    '41250','41270','41280','41285','41290','41310','41360','41370',
    '41390','41410','41430','41450','41461','41463','41465','41480',
    '41500','41550','41570','41590','41610','41630','41650','41670',
    '41710','41720','41730','41750','41760','41770','41780','41790',
    '41800','41820','41830',
  ],
  '강원': [
    '42110','42130','42150','42170','42190','42210','42230','42250',
    '42270','42710','42720','42730','42740','42750','42760','42770','42780','42790',
  ],
  '충북': [
    '43111','43113','43130','43150','43710','43720','43730','43740',
    '43745','43750','43760','43770','43800',
  ],
  '충남': [
    '44131','44133','44150','44180','44200','44210','44230','44710',
    '44720','44730','44740','44750','44760','44770','44790','44800','44810',
  ],
  '전북': [
    '45111','45113','45130','45140','45150','45710','45720','45730',
    '45740','45750','45760','45770','45780','45790',
  ],
  '전남': [
    '46110','46130','46150','46170','46710','46720','46730','46740',
    '46750','46760','46770','46780','46790','46800','46810','46820','46830','46840','46860',
  ],
  '경북': [
    '47111','47113','47130','47150','47170','47190','47210','47230',
    '47710','47720','47730','47740','47745','47750','47760','47770','47780',
    '47790','47820','47830','47840','47850','47900',
  ],
  '경남': [
    '48121','48123','48125','48127','48129','48131','48133','48170',
    '48220','48240','48250','48270','48310','48330','48720','48730',
    '48740','48750','48760','48770','48780','48790','48820','48840','48850','48860','48870','48880',
  ],
  '제주': ['50110','50130'],
};

// 전국 코드 (모든 지역 합치기)
const ALL_CODES = Object.values(SIGUNGU_CODES).flat();

// ── 타입 ──
interface ApiResponse {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      items: { item: Record<string, unknown>[] } | Record<string, unknown>[];
      numOfRows: number;
      pageNo: number;
      totalCount: number;
    };
  };
}

interface CollectState {
  version: number;
  lastRunAt: string;
  collected: Record<string, string>; // "YYYYMM_LAWD_CD" → ISO
}

// ── 유틸 ──
function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function getPrevMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function expandYmRange(range: string): string[] {
  const [start, end] = range.split('-');
  if (!end) return [start];
  const months: string[] = [];
  let y = parseInt(start.slice(0, 4));
  let m = parseInt(start.slice(4));
  const ey = parseInt(end.slice(0, 4));
  const em = parseInt(end.slice(4));
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function loadState(path: string | null): CollectState {
  if (!path || !existsSync(path)) {
    return { version: 1, lastRunAt: '', collected: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CollectState;
  } catch {
    return { version: 1, lastRunAt: '', collected: {} };
  }
}

function saveState(path: string, state: CollectState) {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── API 호출 ──
async function fetchPage(
  endpoint: string,
  serviceKey: string,
  lawdCd: string,
  dealYmd: string,
  pageNo: number,
  numOfRows = 1000,
): Promise<{ items: Record<string, unknown>[]; totalCount: number }> {
  // serviceKey는 공공데이터포털에서 이미 URL 인코딩된 상태로 발급됨.
  // URLSearchParams.set()은 값을 재인코딩하므로 이중 인코딩 → 403 발생.
  // serviceKey만 직접 쿼리스트링에 붙이고 나머지는 searchParams 사용.
  const otherParams = new URLSearchParams({
    LAWD_CD: lawdCd,
    DEAL_YMD: dealYmd,
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
    _type: 'json',
  });
  const finalUrl = `${endpoint}?serviceKey=${serviceKey}&${otherParams.toString()}`;

  const res = await fetch(finalUrl, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as ApiResponse;
  const header = data.response?.header;

  if (header?.resultCode !== '00') {
    throw new Error(`API 오류 [${header?.resultCode}]: ${header?.resultMsg}`);
  }

  const body = data.response?.body;
  const totalCount = body?.totalCount ?? 0;

  // items가 배열인 경우와 객체인 경우 모두 처리
  let items: Record<string, unknown>[] = [];
  if (Array.isArray(body?.items)) {
    items = body.items as Record<string, unknown>[];
  } else if (body?.items && typeof body.items === 'object' && 'item' in body.items) {
    const raw = (body.items as { item: unknown }).item;
    items = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [raw as Record<string, unknown>];
  }

  return { items, totalCount };
}

async function collectRegionMonth(
  endpoint: string,
  serviceKey: string,
  lawdCd: string,
  dealYmd: string,
): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];
  let pageNo = 1;
  const numOfRows = 1000;

  while (true) {
    const { items, totalCount } = await fetchPage(endpoint, serviceKey, lawdCd, dealYmd, pageNo, numOfRows);
    allItems.push(...items);

    if (allItems.length >= totalCount || items.length < numOfRows) break;
    pageNo++;
    await delay(300); // rate limit
  }

  return allItems;
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

const dataType = args['type'] || 'apt-trade';
const endpoint = ENDPOINTS[dataType];
if (!endpoint) {
  console.error(`알 수 없는 데이터 유형: ${dataType}`);
  console.error(`지원: ${Object.keys(ENDPOINTS).join(', ')}`);
  process.exit(1);
}

const serviceKey = args['service-key'] || process.env.MOLIT_SERVICE_KEY || '';
if (!serviceKey && args['dry-run'] !== 'true') {
  console.error('❌ serviceKey 필요: --service-key 또는 MOLIT_SERVICE_KEY 환경변수 설정');
  process.exit(1);
}

// 연월 결정
const ymList: string[] = args['ym-range']
  ? expandYmRange(args['ym-range'])
  : [args['ym'] || getPrevMonth()];

// 지역 코드 결정
const regionArg = args['regions'] || '전국';
let targetCodes: string[];
if (regionArg === '전국') {
  targetCodes = ALL_CODES;
} else {
  const regionNames = regionArg.split(',').map(r => r.trim());
  targetCodes = regionNames.flatMap(name => SIGUNGU_CODES[name] ?? []);
  if (targetCodes.length === 0) {
    console.error(`알 수 없는 지역: ${regionArg}`);
    console.error(`지원: ${Object.keys(SIGUNGU_CODES).join(', ')}`);
    process.exit(1);
  }
}

const outputPath = args['output'] || '/tmp/molit-result.json';
const stateFilePath = args['state-file'] || null;
const dryRun = args['dry-run'] === 'true';

console.log(`\n=== 국토부 실거래가 수집 시작 ===`);
console.log(`유형: ${dataType}`);
console.log(`연월: ${ymList.join(', ')}`);
console.log(`지역: ${regionArg} (${targetCodes.length}개 시군구)`);
console.log(`dry-run: ${dryRun}`);

if (dryRun) {
  console.log('\n[dry-run] 수집 대상:');
  for (const ym of ymList) {
    for (const code of targetCodes.slice(0, 3)) {
      console.log(`  ${ym} / ${code}`);
    }
    if (targetCodes.length > 3) console.log(`  ... 외 ${targetCodes.length - 3}개`);
  }
  console.log(`\n총 ${ymList.length * targetCodes.length}건 API 호출 예정`);
  process.exit(0);
}

// State 로드
const state = loadState(stateFilePath);
const prevCollected = Object.keys(state.collected).length;
console.log(`기수집 키: ${prevCollected}개`);

// 수집 실행
const allItems: Record<string, unknown>[] = [];
let successCount = 0;
let skipCount = 0;
let errorCount = 0;

const totalJobs = ymList.length * targetCodes.length;
let jobNo = 0;

for (const ym of ymList) {
  for (const lawdCd of targetCodes) {
    jobNo++;
    const stateKey = `${ym}_${lawdCd}`;

    // 증분 체크
    if (stateFilePath && state.collected[stateKey]) {
      skipCount++;
      continue;
    }

    if (jobNo % 50 === 1) {
      console.log(`[${jobNo}/${totalJobs}] ${ym}/${lawdCd} 수집 중...`);
    }

    try {
      const items = await collectRegionMonth(endpoint, serviceKey, lawdCd, ym);

      // 지역/연월 메타 추가
      for (const item of items) {
        item._lawdCd = lawdCd;
        item._dealYmd = ym;
        item._collectedAt = new Date().toISOString();
      }

      allItems.push(...items);
      state.collected[stateKey] = new Date().toISOString();
      successCount++;

      if (items.length > 0 && jobNo % 50 === 1) {
        console.log(`  → ${items.length}건`);
      }

      await delay(100); // rate limit 방지
    } catch (e) {
      console.error(`  ❌ ${ym}/${lawdCd} 실패: ${e}`);
      errorCount++;
    }
  }
}

// State 저장
if (stateFilePath && successCount > 0) {
  state.lastRunAt = new Date().toISOString();
  saveState(stateFilePath, state);
  console.log(`[state] ${Object.keys(state.collected).length}개 키 저장 → ${stateFilePath}`);
}

// 결과 저장
const output = {
  meta: {
    dataType,
    regions: regionArg,
    ymList,
    totalItems: allItems.length,
    successJobs: successCount,
    skipJobs: skipCount,
    errorJobs: errorCount,
    collectedAt: new Date().toISOString(),
  },
  items: allItems,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));

console.log(`\n=== 수집 완료 ===`);
console.log(`총 거래건수: ${allItems.length}건`);
console.log(`성공: ${successCount}, 스킵: ${skipCount}, 실패: ${errorCount}`);
console.log(`결과: ${outputPath}`);

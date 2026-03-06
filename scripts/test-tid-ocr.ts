import { extractSummaryInfo } from '../src/detection/summary-info';
import fs from 'fs/promises';

async function main() {
  const frame = await fs.readFile('debug-screenshots/sw2-11-summary-screen.png');
  const info = await extractSummaryInfo(frame);
  console.log('Nature:', info.nature);
  console.log('Gender:', info.gender);
  console.log('TID:', info.tid);
  console.log('Expected TID: 64197');
  console.log(info.tid === 64197 ? 'PASS' : 'FAIL');
  process.exit(info.tid === 64197 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });

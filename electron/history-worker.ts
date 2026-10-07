import { parentPort, workerData } from 'node:worker_threads';
import { History } from './history';
let history: History | undefined;
try {
  history = new History(workerData.path, 512, true);
  parentPort!.postMessage(history.search(undefined, workerData.query, workerData.options));
} catch (error) {
  parentPort!.postMessage({ error: (error as Error).message });
} finally {
  history?.db.close();
}

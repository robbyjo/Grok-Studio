import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcProcess } from '../electron/rpc';
async function main() {
  const executable = resolve(process.argv[2] ?? '.runtime/grok.exe');
  const home = resolve('.test-data/runtime-smoke');
  mkdirSync(home, { recursive: true });
  const rpc = new RpcProcess(executable, ['agent', '--no-leader', 'stdio'], process.cwd(), {
    ...process.env,
    GROK_HOME: home,
    XAI_API_KEY: '',
    GROK_DEPLOYMENT_KEY: '',
  });
  rpc.on('request', (message) =>
    rpc.reject(message.id, -32601, 'Smoke test does not implement reverse requests.'),
  );
  try {
    const initialized = await rpc.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'grok-desktop-smoke', version: '0.1.0' },
      },
      45_000,
    );
    console.log(
      JSON.stringify(
        {
          protocolVersion: initialized.protocolVersion,
          agentInfo: initialized.agentInfo,
          capabilities: initialized.agentCapabilities,
          authMethods: initialized.authMethods?.map((method: { id: string }) => method.id),
        },
        null,
        2,
      ),
    );
    if (initialized.protocolVersion !== 1) throw new Error('ACP v1 not supported.');
    console.log('ACP_INITIALIZE_OK (no authentication and no model prompt sent)');
  } finally {
    rpc.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

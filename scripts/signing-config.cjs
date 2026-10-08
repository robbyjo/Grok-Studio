// Optional local/CI signing build config; no credentials or paid resources are created here.
const build = require('../package.json').build;
const required = (name) => {
  const value = process.env[name];
  if (!value || /[\r\n\0]/.test(value))
    throw new Error(`Configure ${name} locally or as a CI secret.`);
  return value;
};
const azure = process.env.GROK_SIGNING_PROVIDER === 'azure';
let win = { ...build.win };
if (azure) {
  const endpoint = required('GROK_SIGNING_ENDPOINT');
  if (!/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(endpoint))
    throw new Error('Expected an Azure Artifact Signing regional endpoint.');
  win.azureSignOptions = {
    endpoint,
    publisherName: required('GROK_SIGNER_NAME'),
    codeSigningAccountName: required('GROK_SIGNING_ACCOUNT'),
    certificateProfileName: required('GROK_SIGNING_PROFILE'),
    fileDigest: 'SHA256',
    timestampDigest: 'SHA256',
    timestampRfc3161: 'http://timestamp.acs.microsoft.com',
  };
} else if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
  throw new Error(
    'Set GROK_SIGNING_PROVIDER=azure or provide a locally managed CSC_LINK certificate.',
  );
}
module.exports = { ...build, forceCodeSigning: true, win };

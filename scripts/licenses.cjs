const fs = require('node:fs');
const path = require('node:path');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const notices = [
  'Production dependency license notices for Grok Workbench\nGenerated from the installed package-lock.json graph.\n',
];
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev) continue;
  const directory = path.resolve(location);
  if (!fs.existsSync(directory)) continue; // Other-platform optional binaries are not shipped here.
  const meta = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  notices.push(
    `\n${'='.repeat(72)}\n${meta.name}@${meta.version}\nLicense: ${meta.license ?? info.license ?? 'See package notices'}\n`,
  );
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^(license|licence|copying|notice)(\.|$)/i.test(name));
  for (const file of files)
    if (fs.statSync(path.join(directory, file)).isFile())
      notices.push(`\n${file}\n${fs.readFileSync(path.join(directory, file), 'utf8')}\n`);
  if (!files.length)
    notices.push(
      'No top-level license text found; refer to the package source and bundled files.\n',
    );
}
fs.writeFileSync('DEPENDENCY-LICENSES.txt', notices.join(''));
console.log('Generated production dependency notices.');

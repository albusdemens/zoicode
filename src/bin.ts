// The `zoicode` command. It checks the Node.js version before loading the app (dist/main.js), whose
// dependencies need a recent Node and would otherwise fail with a confusing error. Keep this file to
// syntax that old versions can parse: Ubuntu's own package, for one, is far older than 22.12.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Zoi Code needs Node.js 22.12 or newer, and this is ${process.version}.`);
  console.error('Install a newer one with nvm (https://github.com/nvm-sh/nvm): nvm install 22');
  process.exit(1);
}
const app: string = './main.js'; // built next to this file, in dist/
import(app);

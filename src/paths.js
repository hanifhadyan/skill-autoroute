import { homedir } from 'node:os';
import { join } from 'node:path';

export const dataDir = (scope) => (scope === 'project' ? join(process.cwd(), '.skill-autoroute') : join(homedir(), '.config', 'skill-autoroute'));
export const routesPath = (scope) => join(dataDir(scope), 'routes.json');
export const reportPath = (scope) => join(dataDir(scope), 'install-report.json');
export const hookCopyPath = (scope) => join(dataDir(scope), 'route.js');
export const logPath = () => join(dataDir('user'), 'usage.log');

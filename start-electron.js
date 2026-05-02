const { spawn } = require('child_process');
const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electronPath, ['.'], { stdio: 'inherit', env });

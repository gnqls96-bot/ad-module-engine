#!/usr/bin/env node
// ame = ad-module-engine 명령어. TypeScript 소스를 바로 실행한다.
import { register } from 'tsx/esm/api';
register();
await import('../src/cli/index.ts');

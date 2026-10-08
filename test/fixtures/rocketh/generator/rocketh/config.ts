import type {UserConfig} from 'rocketh/types';
export const config = {
  accounts: {deployer: {default: 0}, admin: {default: 1}},
  data: {},
} as const satisfies UserConfig;
import * as deployExtension from '@rocketh/deploy';
import * as proxyExtension from '@rocketh/proxy';
const extensions = {...deployExtension, ...proxyExtension};
export {extensions};
type Extensions = typeof extensions;
type Accounts = typeof config.accounts;
type Data = typeof config.data;
export type {Extensions, Accounts, Data};

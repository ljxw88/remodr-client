// Re-export the native module. On web, it will be resolved to RemoteCoreModule.web.ts
// and on native platforms to RemoteCoreModule.ts
export { default } from './src/RemoteCoreModule';
export * from './src/RemoteCore.types';

// The source keeps upstream's literal `process.env.NODE_ENV` reads so
// bundlers can statically replace them and dead-code-eliminate the debug
// branches. This ambient declaration only serves this package's own
// standalone typecheck; consumers never load it (their type surface is
// types/index.d.ts via the exports map).
declare const process: { env: { NODE_ENV?: string } };

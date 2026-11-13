import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify') || !watch;

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'node:sqlite'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !minify,
  minify,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching src/extension.ts for changes...');
} else {
  await esbuild.build(buildOptions);
}

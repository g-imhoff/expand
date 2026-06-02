// Ambient declaration so `tsc` accepts side-effect CSS imports (e.g.
// `import "./index.css"` in main.tsx). Vite handles the actual bundling; this
// only satisfies the type-checker. The desktop tsconfig pins `types` to
// node/react/react-dom and does not pull in `vite/client`, so we declare the
// module shape here rather than widening the global type surface.
declare module "*.css" {}

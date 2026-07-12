/**
 * Resolve a public-asset path against Vite's BASE_URL so the built app works
 * from any subdirectory on a server, not just the domain root.
 * assetUrl('/textures/mars.jpg') → './textures/mars.jpg' with base './'.
 */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, '');
}

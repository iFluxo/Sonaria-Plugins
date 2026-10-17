/** Whether the URL looks like a SoundCloud page (track, set or profile). */
export function isSoundCloudUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\//iu.test(url.trim());
}

/**
 * Test fixture dedicated worker for T36d2b native crash browser verification.
 * Throws a synthetic Error upon receiving any message.
 */
self.addEventListener('message', () => {
  throw new Error('Synthetic worker error for native crash smoke test');
});

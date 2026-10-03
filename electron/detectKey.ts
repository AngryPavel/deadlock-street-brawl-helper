/** F8 is registered only while a Deadlock (or test-mode dummy) window exists, so it stays free for other programs. */
export const shouldRegisterDetectKey = (
  gameExists: boolean,
  registered: boolean,
): 'register' | 'unregister' | 'keep' =>
  gameExists && !registered ? 'register' : !gameExists && registered ? 'unregister' : 'keep';

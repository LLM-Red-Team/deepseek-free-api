import crypto from 'crypto';
import { parentPort } from 'worker_threads';

parentPort?.on('message', (data) => {
  try {
    const { algorithm, challenge, salt, difficulty, expire_at, signature } = data;
    let answer = 0;
    let i = difficulty - 1;
    
    for (let r = 0; r <= i; r++) {
      const str = "".concat(salt, "_").concat(expire_at, "_").concat(r.toString());
      const hash = crypto.createHash('sha256').update(str).digest('hex');
      if (hash === challenge) {
        answer = r;
        break;
      }
    }
    
    if(answer === 0) throw new Error('No solution found');
    
    parentPort?.postMessage({
      algorithm,
      challenge, 
      salt,
      answer,
      signature
    });
  } catch (error) {
    parentPort?.postMessage({ error: error.message });
  }
}); 
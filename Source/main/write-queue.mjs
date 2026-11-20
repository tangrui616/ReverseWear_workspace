export function createWriteQueue() {
  let pending = Promise.resolve();

  function serialize(operation) {
    const job = pending.then(operation);
    pending = job.catch(() => {});
    return job;
  }

  return { serialize, afterWrites: operation => pending.then(operation) };
}

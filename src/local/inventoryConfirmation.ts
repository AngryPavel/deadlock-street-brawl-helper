/** Card stability cannot stand in for inventory stability. A changed pixel signature triggers
 * recognition; a second read is required even when the next entire frame is identical. */
export class InventoryConfirmation {
  private signature = '';
  private candidate: string | null = null;
  private hits = 0;
  private sent: string | null = null;
  reset() {
    this.signature = '';
    this.candidate = this.sent = null;
    this.hits = 0;
  }
  needsRead(signature: string) {
    return signature !== this.signature || this.hits < 2;
  }
  observe(ids: number[], signature: string): number[] | null {
    const sorted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
    const key = sorted.join(',');
    this.hits = key === this.candidate ? this.hits + 1 : 1;
    this.candidate = key;
    this.signature = signature;
    if (this.hits < 2 || key === this.sent) return null;
    this.sent = key;
    return sorted;
  }
}

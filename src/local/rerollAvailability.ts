export interface RerollContext {
  key: string;
  round: number;
  choice: number;
}
export const sameRerollContext = (a: RerollContext, b: RerollContext) =>
  a.key === b.key && a.round === b.round && a.choice === b.choice;

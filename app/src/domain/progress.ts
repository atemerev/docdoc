export interface ProcessingProgress {
  stage: "prepare" | "blank" | "recognize" | "check" | "split" | "details";
  completed?: number;
  total?: number;
  pageIds?: number[];
  completedPageIds?: number[];
  activePageIds?: number[];
}
export type PageWorkState = "waiting" | "reading" | "read" | "checking" | "done" | "excluded";
export interface QueueProgress {
  id: number;
  label: string;
  progress: ProcessingProgress | null;
  startedAt: string;
  updatedAt: string;
  pages: Array<{id:number; state:PageWorkState}>;
}
export type ReportProgress = (label: string, progress?: ProcessingProgress) => void;

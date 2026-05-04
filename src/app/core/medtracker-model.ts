export type Medication = {
  id: string;
  name: string;
  times: string[];
  stockCount: number | null;
};

export type LogEntry = {
  id: string;
  medicationId: string;
  medicationName: string;
  dateKey: string;
  time: string;
  status: 'taken' | 'skipped';
  updatedAt: string;
};

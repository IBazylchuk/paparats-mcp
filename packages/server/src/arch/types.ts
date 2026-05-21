export type ArchKind = 'component' | 'decision' | 'lesson';
export type ArchStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';
export type ArchScope = 'global' | 'component' | 'file';
export type ArchSeverity = 'info' | 'warning' | 'critical';

interface ArchBase {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArchComponent extends ArchBase {
  kind: 'component';
  name: string;
  summary: string;
  files: string[];
  neighbours: string[];
  anchors: string[];
}

export interface ArchDecision extends ArchBase {
  kind: 'decision';
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: ArchStatus;
  supersedes: string | null;
  scope: ArchScope;
}

export interface ArchLesson extends ArchBase {
  kind: 'lesson';
  summary: string;
  scope: ArchScope;
  evidence: string | null;
  severity: ArchSeverity;
  status: ArchStatus;
}

export type ArchPoint = ArchComponent | ArchDecision | ArchLesson;

export interface ArchContextResult {
  components: ArchComponent[];
  decisions: ArchDecision[];
  lessons: ArchLesson[];
  empty: boolean;
  hint: string | null;
}

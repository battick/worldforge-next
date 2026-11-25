import type { WorkspaceCommand, Receipt } from './workspace.ts';
export const operations = ['read', 'create', 'modify', 'delete', 'save', 'apply'] as const;
export type Operation = typeof operations[number];
export type Permission = 'allow' | 'ask' | 'deny';
export interface Policy {
  configured: boolean; initiative: 'respond' | 'suggest' | 'advance'; contribution: 'organize' | 'expand' | 'create';
  permissions: Record<Operation, Permission>; version: number;
}
export interface Session { id: string; name: string; policy: Policy }
export interface Target { kind: 'object' | 'field' | 'resource' | 'definition'; id: string; objectId?: string }
export interface Protection { key: string; target: Target; enabled: boolean; version: number }
export interface Requirement { key: string; operation: Operation; target?: Target; reason?: string; protection?: string }
export type AgentTaskStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'paused' | 'interrupted' | 'conflict' | 'failed' | 'completed' | 'cancelled';
export interface AgentTask {
  id: string; sessionId: string; title: string; intent: 'read' | 'change'; reads: Target[]; command?: WorkspaceCommand;
  status: AgentTaskStatus; step: string; version: number; policy?: Policy; grants: string[]; needed: Requirement[];
  createdAt: string; updatedAt: string; receipt?: Receipt; result?: { target: Target; value: unknown }[]; error?: string;
  /** Failed tasks may retry their unchanged plan; absent on legacy failures means recheck on resume. */
  retryable?: boolean;
}
export interface CollaborationView { eventId: number; defaults: Policy; sessions: Session[]; protections: Protection[]; tasks: AgentTask[] }
export type AgentAction =
  | { type: 'policy.update'; sessionId?: string; expectedVersion: number; policy: Omit<Policy, 'version'> }
  | { type: 'session.create'; id: string; name: string }
  | { type: 'protection.set'; target: Target; enabled: boolean; expectedVersion: number }
  | { type: 'task.enqueue'; id: string; sessionId: string; title: string; intent: 'read' | 'change'; reads: Target[]; command?: WorkspaceCommand }
  | { type: 'task.approve' | 'task.pause' | 'task.resume' | 'task.cancel'; id: string; expectedVersion: number };

export interface Point {
  x: number;
  y: number;
}

export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";
export type Difficulty = "EASY" | "MEDIUM" | "HARD" | "INSANE";

export interface GameState {
  snake: Point[];
  food: Point;
  obstacles: Point[];
  direction: Direction;
  difficulty: Difficulty;
  score: number;
  isGameOver: boolean;
  isPaused: boolean;
  highScore: number;
  timeSinceLastFood: number;
}

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  score: number;
  timestamp: any;
  uid: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

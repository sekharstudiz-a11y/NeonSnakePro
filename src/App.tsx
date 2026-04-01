import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  addDoc, 
  serverTimestamp,
  getDocFromServer,
  doc
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Trophy, 
  Play, 
  Pause, 
  RotateCcw, 
  User as UserIcon, 
  LogOut, 
  LogIn,
  Gamepad2,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Volume2,
  VolumeX,
  Skull,
  Zap,
  Clock
} from 'lucide-react';
import { db, auth, signIn, signOut } from './firebase';
import { 
  Point, 
  Direction, 
  Difficulty,
  GameState, 
  LeaderboardEntry, 
  OperationType, 
  FirestoreErrorInfo 
} from './types';

const GRID_SIZE = 20;
const CANVAS_SIZE = 420;
const GRID_OFFSET = 10;
const GRID_COUNT = 20; // 20x20 grid

const DIFFICULTY_CONFIG = {
  EASY: { initialSpeed: 250, speedIncrement: 1, obstacleInterval: 15000, threshold: 0, color: '#10b981', spawnCount: 1 }, // Emerald
  MEDIUM: { initialSpeed: 180, speedIncrement: 3, obstacleInterval: 20000, threshold: 50, color: '#f59e0b', spawnCount: 2 }, // Amber
  HARD: { initialSpeed: 120, speedIncrement: 6, obstacleInterval: 12000, threshold: 150, color: '#3b82f6', spawnCount: 3 }, // Blue
  INSANE: { initialSpeed: 80, speedIncrement: 10, obstacleInterval: 6000, threshold: 300, color: '#f43f5e', spawnCount: 4 }, // Rose
};

const INITIAL_SNAKE: Point[] = [
  { x: 10, y: 10 },
  { x: 10, y: 11 },
  { x: 10, y: 12 },
];

const SOUNDS = {
  eat: 'eat',
  gameover: 'gameover',
  click: 'click',
};

let audioCtx: AudioContext | null = null;

const playSynthSound = (type: keyof typeof SOUNDS) => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const ctx = audioCtx;
    const now = ctx.currentTime;

    if (type === 'gameover') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.5);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    switch (type) {
      case 'eat':
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      case 'click':
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, now);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
        break;
    }
  } catch (e) {
    console.warn('Audio playback failed:', e);
  }
};

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>({
    snake: INITIAL_SNAKE,
    food: { x: 5, y: 5 },
    obstacles: [],
    direction: 'UP',
    difficulty: 'EASY',
    score: 0,
    isGameOver: false,
    isPaused: true,
    isGameStarted: false,
    highScore: 0,
    timeSinceLastFood: 0,
    initialDistance: 10,
  });

  const [user, setUser] = useState<User | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isFirestoreReady, setIsFirestoreReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showGameOverUI, setShowGameOverUI] = useState(false);
  const [topScores, setTopScores] = useState<LeaderboardEntry[]>([]);
  const [showRules, setShowRules] = useState(false);
  const [isNewTopScore, setIsNewTopScore] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameLoopRef = useRef<number | null>(null);
  const lastMoveTimeRef = useRef<number>(0);
  const lastObstacleTimeRef = useRef<number>(0);
  const lastProcessedDirectionRef = useRef<Direction>('UP');
  const lastDifficultyRef = useRef<Difficulty>('EASY');
  const gameIdRef = useRef(0);
  const lastSubmittedGameIdRef = useRef(-1);
  const hasProcessedGameOverRef = useRef(false);
  const [showLevelUp, setShowLevelUp] = useState<string | null>(null);
  
  useEffect(() => {
    const checkConnection = async () => {
      try {
        // Simple test to see if we can reach Firestore
        await getDocFromServer(doc(db, 'leaderboard', 'connection-test'));
        setIsFirestoreReady(true);
        setIsConnecting(false);
      } catch (err: any) {
        console.error("Firestore connection failed:", err);
        // Even if it fails with 'not-found', it means it reached the server
        if (err.code === 'unavailable') {
          setError("Could not reach Cloud Firestore backend. Please check your internet connection.");
          setIsFirestoreReady(false);
        } else {
          setIsFirestoreReady(true);
        }
        setIsConnecting(false);
      }
    };
    checkConnection();
  }, []);
  
  useEffect(() => {
    if (showLevelUp) {
      const timer = setTimeout(() => setShowLevelUp(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [showLevelUp]);

  useEffect(() => {
    const resumeAudio = () => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    };
    window.addEventListener('click', resumeAudio);
    return () => window.removeEventListener('click', resumeAudio);
  }, []);

  const playSound = useCallback((soundName: keyof typeof SOUNDS) => {
    if (isMuted) return;
    playSynthSound(soundName);
  }, [isMuted]);

  const generatePoint = useCallback((snake: Point[], food: Point, obstacles: Point[], excludeHeadRadius?: { point: Point, radius: number }, excludeFoodRadius?: { point: Point, radius: number }): Point => {
    let newPoint: Point;
    while (true) {
      newPoint = {
        x: Math.floor(Math.random() * GRID_COUNT),
        y: Math.floor(Math.random() * GRID_COUNT),
      };
      const onSnake = snake.some(s => s.x === newPoint.x && s.y === newPoint.y);
      const onFood = food.x === newPoint.x && food.y === newPoint.y;
      const onObstacle = obstacles.some(o => o.x === newPoint.x && o.y === newPoint.y);
      
      let tooCloseToHead = false;
      if (excludeHeadRadius) {
        const dist = Math.sqrt(Math.pow(newPoint.x - excludeHeadRadius.point.x, 2) + Math.pow(newPoint.y - excludeHeadRadius.point.y, 2));
        if (dist < excludeHeadRadius.radius) tooCloseToHead = true;
      }

      let tooCloseToFood = false;
      if (excludeFoodRadius) {
        const dist = Math.sqrt(Math.pow(newPoint.x - excludeFoodRadius.point.x, 2) + Math.pow(newPoint.y - excludeFoodRadius.point.y, 2));
        if (dist < excludeFoodRadius.radius) tooCloseToFood = true;
      }

      if (!onSnake && !onFood && !onObstacle && !tooCloseToHead && !tooCloseToFood) break;
    }
    return newPoint;
  }, []);

  const resetGame = useCallback((difficulty: Difficulty) => {
    gameIdRef.current += 1;
    hasProcessedGameOverRef.current = false;
    console.log(`[SIMULATION START] Difficulty: ${difficulty}`);
    playSound('click');
    lastDifficultyRef.current = difficulty;
    const newFood = { x: 5, y: 5 };
    const initialDist = Math.abs(INITIAL_SNAKE[0].x - newFood.x) + Math.abs(INITIAL_SNAKE[0].y - newFood.y);
    setGameState(prev => ({
      ...prev,
      snake: INITIAL_SNAKE,
      food: newFood,
      obstacles: [],
      direction: 'UP',
      difficulty,
      score: 0,
      isGameOver: false,
      isPaused: false,
      isGameStarted: true,
      timeSinceLastFood: 0,
      initialDistance: initialDist,
    }));
    setShowMenu(false);
    setShowGameOverUI(false);
    lastObstacleTimeRef.current = performance.now();
  }, [playSound]);

  const submitScore = useCallback(async (finalScore: number, difficulty: Difficulty) => {
    if (finalScore <= 0) return;
    
    const multipliers: Record<Difficulty, number> = {
      EASY: 1,
      MEDIUM: 2,
      HARD: 3,
      INSANE: 5
    };
    const weightedScore = finalScore * multipliers[difficulty];

    try {
      await addDoc(collection(db, 'leaderboard'), {
        displayName: user?.displayName || 'Anonymous',
        score: finalScore,
        weightedScore,
        difficulty,
        timestamp: serverTimestamp(),
        uid: user?.uid || 'anonymous'
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'leaderboard');
    }
  }, [user]);

  // Difficulty Progression Notification
  useEffect(() => {
    if (gameState.difficulty !== lastDifficultyRef.current && !gameState.isGameOver && !gameState.isPaused && gameState.score > 0) {
      setShowLevelUp(gameState.difficulty);
      const timer = setTimeout(() => setShowLevelUp(null), 2000);
      lastDifficultyRef.current = gameState.difficulty;
      return () => clearTimeout(timer);
    }
  }, [gameState.difficulty, gameState.isGameOver, gameState.isPaused, gameState.score]);

  // Game Over Sound Trigger & UI Delay
  useEffect(() => {
    if (gameState.isGameOver && !hasProcessedGameOverRef.current) {
      hasProcessedGameOverRef.current = true;
      lastSubmittedGameIdRef.current = gameIdRef.current;
      
      // Submit score
      submitScore(gameState.score, gameState.difficulty);
      playSound('gameover');
      
      // Check if top 5 (using current leaderboard state)
      const isTop5 = leaderboard.length < 5 || gameState.score > (leaderboard[4]?.score || 0);
      setIsNewTopScore(isTop5 && gameState.score > 0);
      
      // Show UI immediately
      setShowGameOverUI(true);
      setShowRules(false);
    } else if (!gameState.isGameOver) {
      setShowGameOverUI(false);
      setIsNewTopScore(false);
    }
  }, [gameState.isGameOver, gameState.score, gameState.difficulty, submitScore, playSound]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Leaderboard Listener
  useEffect(() => {
    if (!isFirestoreReady) return;
    const q = query(collection(db, 'leaderboard'), orderBy('weightedScore', 'desc'), limit(5));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LeaderboardEntry[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as LeaderboardEntry));
      setLeaderboard(entries);
      setTopScores(entries); // Keep both for compatibility if needed elsewhere
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'leaderboard');
    });
    return () => unsubscribe();
  }, [isFirestoreReady]);

  const moveSnake = useCallback(() => {
    setGameState(prev => {
      if (prev.isGameOver || prev.isPaused) return prev;

      lastProcessedDirectionRef.current = prev.direction;
      const head = { ...prev.snake[0] };
      switch (prev.direction) {
        case 'UP': head.y -= 1; break;
        case 'DOWN': head.y += 1; break;
        case 'LEFT': head.x -= 1; break;
        case 'RIGHT': head.x += 1; break;
      }

      // Check wall collision
      if (head.x < 0 || head.x >= GRID_COUNT || head.y < 0 || head.y >= GRID_COUNT) {
        console.log(`[SIMULATION END] Reason: Wall Collision at {x: ${head.x}, y: ${head.y}}`);
        return { ...prev, isGameOver: true };
      }

      // Check self collision
      if (prev.snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        console.log(`[SIMULATION END] Reason: Self-Collision at {x: ${head.x}, y: ${head.y}}`);
        return { ...prev, isGameOver: true };
      }

      // Check obstacle collision
      if (prev.obstacles.some(o => o.x === head.x && o.y === head.y)) {
        console.log(`[SIMULATION END] Reason: Obstacle Collision at {x: ${head.x}, y: ${head.y}}`);
        return { ...prev, isGameOver: true };
      }

      const newSnake = [head, ...prev.snake];
      let newFood = prev.food;
      let newScore = prev.score;
      let newDifficulty = prev.difficulty;
      let newHighScore = prev.highScore;
      let newTimeSinceLastFood = prev.timeSinceLastFood + 1;
      let newInitialDistance = prev.initialDistance;

      // Check food collision
      if (head.x === prev.food.x && head.y === prev.food.y) {
        // Efficiency bonus: (Ideal Distance / Actual Steps)
        const efficiency = prev.initialDistance / Math.max(1, prev.timeSinceLastFood);
        let bonus = 0;
        let penalty = 0;

        if (efficiency >= 1.2) {
          bonus = Math.min(20, Math.floor((efficiency - 1) * 20));
        } else if (efficiency < 0.4) {
          penalty = 15;
        } else if (efficiency < 0.7) {
          penalty = 5;
        }
        
        newScore = Math.max(0, newScore + 10 - penalty + bonus);
        
        if (penalty > 10) {
          console.log(`[DATA COLLECTION] Rodent captured at {x: ${head.x}, y: ${head.y}}. Inefficiency Penalty: ${penalty - 10}. New Score: ${newScore}`);
          playSound('click'); 
        } else {
          console.log(`[DATA COLLECTION] Rodent captured at {x: ${head.x}, y: ${head.y}}. Efficiency Bonus: ${bonus}. New Score: ${newScore}`);
          playSound('eat');
        }
        
        newHighScore = Math.max(newHighScore, newScore);
        newFood = generatePoint(newSnake, prev.food, prev.obstacles);
        newInitialDistance = Math.abs(head.x - newFood.x) + Math.abs(head.y - newFood.y);
        newTimeSinceLastFood = 0;

        // Auto-increase difficulty
        if (newScore >= DIFFICULTY_CONFIG.INSANE.threshold && prev.difficulty !== 'INSANE') {
          newDifficulty = 'INSANE';
          setShowLevelUp('INSANE');
          console.log(`[SYSTEM UPGRADE] Difficulty increased to INSANE at score ${newScore}`);
        } else if (newScore >= DIFFICULTY_CONFIG.HARD.threshold && prev.difficulty === 'MEDIUM') {
          newDifficulty = 'HARD';
          setShowLevelUp('HARD');
          console.log(`[SYSTEM UPGRADE] Difficulty increased to HARD at score ${newScore}`);
        } else if (newScore >= DIFFICULTY_CONFIG.MEDIUM.threshold && prev.difficulty === 'EASY') {
          newDifficulty = 'MEDIUM';
          setShowLevelUp('MEDIUM');
          console.log(`[SYSTEM UPGRADE] Difficulty increased to MEDIUM at score ${newScore}`);
        }
      } else {
        newSnake.pop();
      }

      return {
        ...prev,
        snake: newSnake,
        food: newFood,
        score: newScore,
        difficulty: newDifficulty,
        highScore: newHighScore,
        timeSinceLastFood: newTimeSinceLastFood,
        initialDistance: newInitialDistance
      };
    });
  }, [generatePoint, user, playSound]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const lastDir = lastProcessedDirectionRef.current;
      switch (e.key) {
        case 'ArrowUp': setGameState(prev => lastDir !== 'DOWN' ? { ...prev, direction: 'UP' } : prev); break;
        case 'ArrowDown': setGameState(prev => lastDir !== 'UP' ? { ...prev, direction: 'DOWN' } : prev); break;
        case 'ArrowLeft': setGameState(prev => lastDir !== 'RIGHT' ? { ...prev, direction: 'LEFT' } : prev); break;
        case 'ArrowRight': setGameState(prev => lastDir !== 'LEFT' ? { ...prev, direction: 'RIGHT' } : prev); break;
        case ' ': setGameState(prev => ({ ...prev, isPaused: !prev.isPaused })); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const gameLoop = useCallback((time: number) => {
    const config = DIFFICULTY_CONFIG[gameState.difficulty];
    const speed = Math.max(50, config.initialSpeed - (gameState.score / 10) * config.speedIncrement);
    
    if (time - lastMoveTimeRef.current > speed) {
      moveSnake();
      lastMoveTimeRef.current = time;
    }

    // Add obstacle over time (penalty for taking too long)
    if (!gameState.isPaused && !gameState.isGameOver && !showMenu) {
      if (time - lastObstacleTimeRef.current > config.obstacleInterval) {
        setGameState(prev => {
          const count = DIFFICULTY_CONFIG[prev.difficulty].spawnCount;
          const gridWidth = GRID_COUNT;
          const gridHeight = GRID_COUNT;
          
          let cluster: Point[] = [];
          let attempts = 0;
          const MAX_ATTEMPTS = 50;

          while (attempts < MAX_ATTEMPTS) {
            const start = {
              x: Math.floor(Math.random() * gridWidth),
              y: Math.floor(Math.random() * gridHeight),
            };

            const directions = [
              [1, 0], [0, 1], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, -1], [-1, 0]
            ];
            const [dx, dy] = directions[Math.floor(Math.random() * directions.length)];
            
            const currentCluster: Point[] = [];
            let valid = true;

            for (let i = 0; i < count; i++) {
              const p = { x: start.x + i * dx, y: start.y + i * dy };
              
              if (p.x < 0 || p.x >= gridWidth || p.y < 0 || p.y >= gridHeight) {
                valid = false; break;
              }

              const onSnake = prev.snake.some(s => s.x === p.x && s.y === p.y);
              const onFood = prev.food.x === p.x && prev.food.y === p.y;
              const onObstacle = [...prev.obstacles, ...currentCluster].some(o => o.x === p.x && o.y === p.y);
              
              const distToHead = Math.sqrt(Math.pow(p.x - prev.snake[0].x, 2) + Math.pow(p.y - prev.snake[0].y, 2));
              const distToFood = Math.sqrt(Math.pow(p.x - prev.food.x, 2) + Math.pow(p.y - prev.food.y, 2));

              if (onSnake || onFood || onObstacle || distToHead < 4 || distToFood < 2) {
                valid = false; break;
              }
              currentCluster.push(p);
            }

            if (valid) {
              cluster = currentCluster;
              break;
            }
            attempts++;
          }

          return {
            ...prev,
            obstacles: [...prev.obstacles, ...cluster]
          };
        });
        lastObstacleTimeRef.current = time;
      }
    }

    gameLoopRef.current = requestAnimationFrame(gameLoop);
  }, [moveSnake, gameState.score, gameState.difficulty, gameState.isPaused, gameState.isGameOver, showMenu, generatePoint]);

  useEffect(() => {
    gameLoopRef.current = requestAnimationFrame(gameLoop);
    return () => { if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current); };
  }, [gameLoop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw Background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw Grid Border (Subtle)
    ctx.strokeStyle = '#00ff0022';
    ctx.lineWidth = 2;
    ctx.strokeRect(GRID_OFFSET - 2, GRID_OFFSET - 2, (GRID_COUNT * GRID_SIZE) + 4, (GRID_COUNT * GRID_SIZE) + 4);

    // Draw Food (Mouse) - Pixelated style
    const fx = (gameState.food.x * GRID_SIZE) + GRID_OFFSET;
    const fy = (gameState.food.y * GRID_SIZE) + GRID_OFFSET;
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(fx + 2, fy + 2, GRID_SIZE - 4, GRID_SIZE - 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(fx + 4, fy + 4, 4, 4); // Eye
    
    // Draw Obstacles (Rocks/Logs) - Pixelated style
    gameState.obstacles.forEach((o) => {
      const ox = (o.x * GRID_SIZE) + GRID_OFFSET;
      const oy = (o.y * GRID_SIZE) + GRID_OFFSET;
      ctx.fillStyle = '#555555';
      ctx.fillRect(ox + 2, oy + 2, GRID_SIZE - 4, GRID_SIZE - 4);
      ctx.fillStyle = '#333333';
      ctx.fillRect(ox + 4, oy + 4, 4, 4);
    });

    // Draw Snake
    const currentColor = DIFFICULTY_CONFIG[gameState.difficulty].color;
    gameState.snake.forEach((segment, index) => {
      const isHead = index === 0;
      ctx.fillStyle = isHead ? currentColor : `${currentColor}cc`;
      
      const x = (segment.x * GRID_SIZE) + GRID_OFFSET;
      const y = (segment.y * GRID_SIZE) + GRID_OFFSET;
      const padding = 1;
      const size = GRID_SIZE - padding * 2;
      
      ctx.fillRect(x + padding, y + padding, size, size);

      if (isHead) {
        // Eyes
        ctx.fillStyle = 'black';
        const eyeSize = 4;
        const offset = 4;
        
        if (gameState.direction === 'UP' || gameState.direction === 'DOWN') {
          ctx.fillRect(x + offset, y + offset, eyeSize, eyeSize);
          ctx.fillRect(x + GRID_SIZE - offset - eyeSize, y + offset, eyeSize, eyeSize);
        } else {
          ctx.fillRect(x + offset, y + offset, eyeSize, eyeSize);
          ctx.fillRect(x + offset, y + GRID_SIZE - offset - eyeSize, eyeSize, eyeSize);
        }
      }
    });
    ctx.shadowBlur = 0;
  }, [gameState]);

  return (
    <div className="min-h-[100dvh] bg-[#050505] text-[#00ff00] font-arcade selection:bg-[#00ff00]/30 overflow-x-hidden flex flex-col relative">
      <div className="crt-overlay" />
      <div className="crt-flicker fixed inset-0 pointer-events-none z-[10000] bg-white/5 mix-blend-overlay" />
      
      <header className="w-full border-b-4 border-green-500 py-4 sm:py-6 px-4 sm:px-6 bg-black z-50">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="p-2 bg-green-500/20 border-2 border-green-500"><Gamepad2 className="w-5 h-5 sm:w-6 sm:h-6 text-green-500" /></div>
            <h1 className="text-xs sm:text-lg font-arcade arcade-text-glow uppercase tracking-tighter">NEO PRO SNAKE</h1>
          </div>
          <div className="flex items-center gap-3 sm:gap-6">
            <button onClick={() => setIsMuted(!isMuted)} className="p-2 hover:bg-green-500/10 rounded-none transition-all">
              {isMuted ? <VolumeX className="w-5 h-5 sm:w-6 sm:h-6 text-green-900" /> : <Volume2 className="w-5 h-5 sm:w-6 sm:h-6 text-green-500" />}
            </button>
            {user ? (
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="text-right hidden sm:block">
                  <p className="text-[10px] text-green-500/60 uppercase font-arcade leading-none mb-1">PLAYER 1</p>
                  <p className="text-xs font-arcade text-green-500">{user.displayName?.split(' ')[0].toUpperCase()}</p>
                </div>
                <button onClick={signOut} className="p-2 hover:bg-red-500/10 group"><LogOut className="w-5 h-5 text-green-500 group-hover:text-red-500" /></button>
              </div>
            ) : (
              <button onClick={signIn} className="arcade-btn !py-2 !px-4 !text-[10px]">LOGIN</button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full p-4 sm:p-6 lg:p-8 grid grid-cols-1 md:grid-cols-12 gap-8 lg:gap-12">
        <div className="md:col-span-7 flex flex-col gap-4">
          <div className="relative group">
            <div className="absolute -inset-2 bg-green-500/20 blur-xl opacity-50"></div>
            <div 
              className="relative bg-black rounded-none border-8 p-4 sm:p-6 lg:p-8"
              style={{ 
                borderColor: DIFFICULTY_CONFIG[gameState.difficulty].color,
                boxShadow: `0 0 20px ${DIFFICULTY_CONFIG[gameState.difficulty].color}`
              }}
            >
              {/* Game Stats Header - Aligned Row */}
              <div className="absolute top-4 sm:top-6 left-0 right-0 px-4 sm:px-8 z-[70] flex justify-between items-start pointer-events-none">
                <div className="flex flex-col">
                  <p className="text-[10px] uppercase font-arcade font-bold" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>1UP</p>
                  <p className="text-xl sm:text-3xl font-arcade arcade-text-glow" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.score.toString().padStart(5, '0')}</p>
                </div>
                
                <div className="flex flex-col text-center">
                  <p className="text-[10px] uppercase font-arcade text-white font-bold">HI-SCORE</p>
                  <p className="text-xl sm:text-3xl font-arcade arcade-text-glow text-white">{gameState.highScore.toString().padStart(5, '0')}</p>
                </div>

                <div className="flex flex-col text-right">
                  <p className="text-[10px] text-white uppercase font-arcade font-bold">STAGE</p>
                  <p className="text-xl sm:text-3xl font-arcade arcade-text-glow uppercase" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.difficulty}</p>
                </div>
              </div>

              <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} className="w-full aspect-square max-w-[500px] mx-auto block mt-12 sm:mt-16 border-4 border-white/10" />

              <AnimatePresence>
                {showLevelUp && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 pointer-events-none z-40"
                  >
                    {/* Top Message */}
                    <div className="absolute top-1 left-1/2 -translate-x-1/2 flex items-center gap-2 w-full justify-center">
                      <motion.div
                         animate={{ 
                           color: ['#ff4d4d', '#ff00ff', '#ff4d4d'],
                           scale: [1, 1.2, 1]
                         }}
                         transition={{ duration: 0.5, repeat: Infinity }}
                      >
                        <Skull className="w-3 h-3" />
                      </motion.div>
                      <span className="text-[10px] sm:text-xs font-black uppercase tracking-[0.2em] text-white/60 whitespace-nowrap">
                        System Upgrade: {showLevelUp} Mode Active
                      </span>
                      <motion.div
                         animate={{ 
                           color: ['#ff4d4d', '#ff00ff', '#ff4d4d'],
                           scale: [1, 1.2, 1]
                         }}
                         transition={{ duration: 0.5, repeat: Infinity }}
                      >
                        <Skull className="w-3 h-3" />
                      </motion.div>
                    </div>
                    
                    {/* Bottom Message */}
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] sm:text-xs font-black uppercase tracking-[0.2em] text-white/40 whitespace-nowrap">
                      Difficulty Level: {showLevelUp}
                    </div>
                  </motion.div>
                )}

                {(isConnecting || !isFirestoreReady || showGameOverUI || (gameState.isPaused && !gameState.isGameOver)) && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 sm:p-8 text-center z-[60]">
                    <div className="space-y-4 sm:space-y-6 max-w-sm w-full py-4">
                      {isConnecting ? (
                        <div className="space-y-6">
                          <div className="space-y-4">
                            <h2 className="text-2xl font-arcade text-green-500 animate-pulse">CONNECTING...</h2>
                            <div className="w-full h-2 bg-green-500/10 border-2 border-green-500/30 overflow-hidden">
                              <motion.div 
                                className="h-full bg-green-500"
                                animate={{ x: ['-100%', '100%'] }}
                                transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                              />
                            </div>
                            <p className="text-[10px] font-arcade text-green-400 uppercase tracking-widest font-bold">ESTABLISHING LINK</p>
                          </div>
                        </div>
                      ) : !isFirestoreReady ? (
                        <div className="space-y-6">
                          <div className="space-y-4">
                            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                            <h2 className="text-xl font-arcade text-red-500">SYSTEM_ERROR</h2>
                            <p className="text-[10px] font-arcade text-red-400 uppercase font-bold">{error || "BACKEND_UNREACHABLE"}</p>
                          </div>
                          <button 
                            onClick={() => window.location.reload()}
                            className="w-full py-4 bg-red-500 text-black font-arcade text-[10px] hover:bg-red-400 transition-colors"
                          >
                            REBOOT_SYSTEM
                          </button>
                        </div>
                      ) : showRules ? (
                        <div className="space-y-6 text-left max-h-[85vh] flex flex-col">
                          <div className="space-y-2 text-center pb-4 border-b-2 border-green-500/20">
                            <h2 className="text-lg font-arcade text-green-500">MANUAL.EXE</h2>
                            <p className="text-[10px] font-arcade text-green-400 uppercase tracking-widest font-bold">MISSION PARAMETERS</p>
                          </div>
                          
                          <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar flex-1 font-arcade">
                            <section className="space-y-2">
                              <h4 className="text-xs text-green-500">OBJECTIVE</h4>
                              <p className="text-[10px] text-green-500/60 leading-relaxed uppercase">
                                CONSUME DATA PACKETS TO EXPAND SYSTEM. AVOID BOUNDARY WALLS AND HAZARDS.
                              </p>
                            </section>
                            <section className="space-y-2">
                              <h4 className="text-xs text-green-500">CONTROLS</h4>
                              <ul className="text-[10px] text-green-500/60 space-y-1 uppercase">
                                <li>{">"} ARROWS/WASD: NAVIGATE</li>
                                <li>{">"} SPACE: PAUSE/RESUME</li>
                              </ul>
                            </section>
                            <section className="space-y-2">
                              <h4 className="text-xs text-red-500">HAZARDS</h4>
                              <p className="text-[10px] text-red-500/60 leading-relaxed uppercase">WALLS, ROCKS, AND LOGS CAUSE SYSTEM TERMINATION.</p>
                            </section>
                          </div>
                          <button 
                            onClick={() => setShowRules(false)}
                            className="w-full py-4 bg-green-500/10 border-2 border-green-500 text-green-500 font-arcade text-[10px] hover:bg-green-500 hover:text-black transition-all"
                          >
                            RETURN_TO_MAIN
                          </button>
                        </div>
                      ) : showGameOverUI ? (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="space-y-8 relative"
                        >
                          <div className="space-y-4">
                            <motion.div
                              animate={{ 
                                scale: [1, 1.1, 1],
                                filter: ["drop-shadow(0 0 0px #ff0000)", "drop-shadow(0 0 15px #ff0000)", "drop-shadow(0 0 0px #ff0000)"]
                              }}
                              transition={{ duration: 1, repeat: Infinity }}
                            >
                              <Skull className="w-12 h-12 text-red-500 mx-auto" />
                            </motion.div>
                            <h2 className="text-3xl font-arcade text-red-500 tracking-tighter">GAME OVER</h2>
                            
                            {isNewTopScore && (
                              <motion.div
                                animate={{ scale: [1, 1.2, 1] }}
                                transition={{ duration: 0.5, repeat: Infinity }}
                                className="bg-yellow-500 text-black text-[10px] font-arcade px-3 py-1 mx-auto w-fit"
                              >
                                NEW RECORD!
                              </motion.div>
                            )}
                          </div>

                          <div className="bg-green-500/5 border-2 border-green-500/20 p-6 space-y-2">
                            <p className="text-[10px] font-arcade text-green-400 uppercase font-bold">FINAL_SCORE</p>
                            <p className="text-3xl font-arcade text-green-500">{gameState.score.toLocaleString().padStart(5, '0')}</p>
                          </div>

                          <div className="space-y-4">
                            <p className="text-[10px] font-arcade text-green-400 uppercase tracking-widest font-bold">PLAY AGAIN - SELECT DIFFICULTY</p>
                            <div className="grid grid-cols-2 gap-3">
                              {(['EASY', 'MEDIUM', 'HARD', 'INSANE'] as Difficulty[]).map((diff) => (
                                <button
                                  key={diff}
                                  onClick={() => {
                                    resetGame(diff);
                                    setShowGameOverUI(false);
                                  }}
                                  className="py-3 border-2 font-arcade text-[10px] hover:bg-white/5 transition-all uppercase font-bold"
                                  style={{ borderColor: DIFFICULTY_CONFIG[diff].color, color: DIFFICULTY_CONFIG[diff].color }}
                                >
                                  {diff}
                                </button>
                              ))}
                            </div>
                          </div>

                          {!user && (
                            <div className="space-y-4">
                              <p className="text-[10px] font-arcade text-green-400 uppercase font-bold">SIGN IN TO SAVE DATA</p>
                              <button 
                                onClick={signIn}
                                className="w-full py-3 bg-green-500/10 border-2 border-green-500 text-green-500 font-arcade text-[10px] hover:bg-green-500 hover:text-black transition-all"
                              >
                                AUTHENTICATE
                              </button>
                            </div>
                          )}
                        </motion.div>
                      ) : (
                        <div className="space-y-8">
                          <div className="space-y-4">
                            <h2 className="text-3xl font-arcade text-green-500 tracking-tighter">
                              {gameState.isGameStarted ? "PAUSED" : "NEO PRO SNAKE"}
                            </h2>
                            <p className="text-[10px] font-arcade text-green-400 uppercase tracking-widest font-bold">
                              {gameState.isGameStarted ? "SYSTEM STANDBY" : "SELECT DIFFICULTY"}
                            </p>
                          </div>
                          <div className="space-y-4">
                            {gameState.isGameStarted ? (
                              <button 
                                onClick={() => setGameState(p => ({ ...p, isPaused: false }))}
                                className="w-full py-4 bg-green-500 text-black font-arcade text-[12px] hover:bg-green-400 transition-colors shadow-[0_0_20px_rgba(34,197,94,0.4)]"
                              >
                                RESUME_SESSION
                              </button>
                            ) : (
                              <div className="grid grid-cols-2 gap-3">
                                {(['EASY', 'MEDIUM', 'HARD', 'INSANE'] as Difficulty[]).map((diff) => (
                                  <button
                                    key={diff}
                                    onClick={() => resetGame(diff)}
                                    className="py-3 border-2 font-arcade text-[10px] hover:bg-white/5 transition-all uppercase font-bold"
                                    style={{ borderColor: DIFFICULTY_CONFIG[diff].color, color: DIFFICULTY_CONFIG[diff].color }}
                                  >
                                    {diff}
                                  </button>
                                ))}
                              </div>
                            )}
                            {!gameState.isGameStarted && (
                              <button 
                                onClick={() => setShowRules(true)}
                                className="w-full py-3 border-2 border-green-500/30 text-green-500/60 font-arcade text-[10px] hover:border-green-500 hover:text-green-500 transition-all"
                              >
                                VIEW_MANUAL
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="md:col-span-5 space-y-8">
          <section className="bg-black border-4 border-green-500 p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-2 bg-green-500 text-black text-[10px] font-arcade">TOP 5</div>
            <h2 className="text-sm font-arcade mb-6 flex items-center gap-3">
              <Trophy className="w-4 h-4 text-yellow-500" />
              HALL OF FAME
            </h2>
            <div className="space-y-4">
              {leaderboard.length > 0 ? leaderboard.map((entry, i) => (
                <div key={entry.id} className="flex items-center justify-between p-3 border-2 border-green-500/20 bg-green-500/5">
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] font-arcade text-green-400">0{i + 1}</span>
                    <div>
                      <p className="text-[10px] font-arcade uppercase text-white">{entry.displayName}</p>
                      <p className="text-[10px] font-arcade text-green-400 uppercase font-bold">{entry.difficulty}</p>
                    </div>
                  </div>
                  <p className="text-sm font-arcade text-green-500 font-bold">{entry.score.toString().padStart(5, '0')}</p>
                </div>
              )) : (
                <div className="py-12 text-center border-2 border-dashed border-green-500/20">
                  <p className="text-[10px] font-arcade text-green-500/40">NO DATA RECORDED</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="w-full py-8 px-4 border-t-4 border-green-500/30 bg-black mt-auto">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-[10px] font-arcade text-green-400 font-bold">© 1984 NEON_CORP ALL RIGHTS RESERVED</p>
          <div className="flex gap-6">
            <span className="text-[10px] font-arcade text-green-400 font-bold animate-pulse">FREE PLAY</span>
            <span className="text-[10px] font-arcade text-green-400 font-bold">V-01.26</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

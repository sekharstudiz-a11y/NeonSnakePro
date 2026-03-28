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
const CANVAS_SIZE = 400;

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

const playSynthSound = (type: keyof typeof SOUNDS) => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return;
  
  const ctx = new AudioContextClass();
  if (ctx.state === 'suspended') ctx.resume();
  
  if (type === 'gameover') {
    // Synth fallback for gameover
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
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

  const now = ctx.currentTime;

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

  const playSound = useCallback((soundName: keyof typeof SOUNDS) => {
    if (isMuted) return;
    playSynthSound(soundName);
  }, [isMuted]);

  const generatePoint = useCallback((snake: Point[], food: Point, obstacles: Point[], excludeHeadRadius?: { point: Point, radius: number }, excludeFoodRadius?: { point: Point, radius: number }): Point => {
    let newPoint: Point;
    while (true) {
      newPoint = {
        x: Math.floor(Math.random() * (CANVAS_SIZE / GRID_SIZE)),
        y: Math.floor(Math.random() * (CANVAS_SIZE / GRID_SIZE)),
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
      if (head.x < 0 || head.x >= CANVAS_SIZE / GRID_SIZE || head.y < 0 || head.y >= CANVAS_SIZE / GRID_SIZE) {
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
          const gridWidth = CANVAS_SIZE / GRID_SIZE;
          const gridHeight = CANVAS_SIZE / GRID_SIZE;
          
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

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw Walls (Bright Neon Cyan)
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_SIZE - 4, CANVAS_SIZE - 4);

    // Draw Food (Mouse)
    const fx = gameState.food.x * GRID_SIZE;
    const fy = gameState.food.y * GRID_SIZE;
    ctx.font = `${GRID_SIZE - 2}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#ffffff';
    ctx.fillText('🐭', fx + GRID_SIZE/2, fy + GRID_SIZE/2);
    
    // Draw Obstacles (Rocks/Logs)
    gameState.obstacles.forEach((o, i) => {
      const ox = o.x * GRID_SIZE;
      const oy = o.y * GRID_SIZE;
      const emoji = i % 2 === 0 ? '🪨' : '🪵';
      ctx.shadowBlur = 5;
      ctx.shadowColor = '#000000';
      ctx.fillText(emoji, ox + GRID_SIZE/2, oy + GRID_SIZE/2);
    });

    // Draw Snake
    const currentColor = DIFFICULTY_CONFIG[gameState.difficulty].color;
    gameState.snake.forEach((segment, index) => {
      const isHead = index === 0;
      ctx.fillStyle = isHead ? currentColor : `${currentColor}cc`;
      ctx.shadowBlur = isHead ? 20 : 0;
      ctx.shadowColor = currentColor;
      
      const x = segment.x * GRID_SIZE;
      const y = segment.y * GRID_SIZE;
      const padding = 4;
      const size = GRID_SIZE - padding * 2;
      
      let drawX = x + padding;
      let drawY = y + padding;
      let drawW = size;
      let drawH = size;

      // Check neighbors to close gaps
      const prevSeg = index > 0 ? gameState.snake[index - 1] : null;
      const nextSeg = index < gameState.snake.length - 1 ? gameState.snake[index + 1] : null;

      [prevSeg, nextSeg].forEach(neighbor => {
        if (!neighbor) return;
        if (neighbor.x < segment.x) { // Neighbor is LEFT
          const diff = x - (x + padding); // should be -padding
          drawX = x;
          drawW += padding;
        } else if (neighbor.x > segment.x) { // Neighbor is RIGHT
          drawW += padding;
        } else if (neighbor.y < segment.y) { // Neighbor is UP
          drawY = y;
          drawH += padding;
        } else if (neighbor.y > segment.y) { // Neighbor is DOWN
          drawH += padding;
        }
      });
      
      // Rounded segment
      ctx.beginPath();
      ctx.roundRect(drawX, drawY, drawW, drawH, isHead ? 6 : 2);
      ctx.fill();

      if (isHead) {
        // Eyes
        ctx.fillStyle = 'black';
        ctx.shadowBlur = 0;
        const eyeSize = 2;
        const offset = padding + 2;
        
        if (gameState.direction === 'UP' || gameState.direction === 'DOWN') {
          ctx.fillRect(x + offset, y + GRID_SIZE/2 - 1, eyeSize, eyeSize);
          ctx.fillRect(x + GRID_SIZE - offset - eyeSize, y + GRID_SIZE/2 - 1, eyeSize, eyeSize);
        } else {
          ctx.fillRect(x + GRID_SIZE/2 - 1, y + offset, eyeSize, eyeSize);
          ctx.fillRect(x + GRID_SIZE/2 - 1, y + GRID_SIZE - offset - eyeSize, eyeSize, eyeSize);
        }
        
        // Tongue (flickering effect)
        if (Math.floor(Date.now() / 200) % 2 === 0) {
          ctx.strokeStyle = '#ff4d4d';
          ctx.lineWidth = 1;
          ctx.beginPath();
          let tx = x + GRID_SIZE/2, ty = y + GRID_SIZE/2;
          switch(gameState.direction) {
            case 'UP': ty = y - 2; break;
            case 'DOWN': ty = y + GRID_SIZE + 2; break;
            case 'LEFT': tx = x - 2; break;
            case 'RIGHT': tx = x + GRID_SIZE + 2; break;
          }
          ctx.moveTo(x + GRID_SIZE/2, y + GRID_SIZE/2);
          ctx.lineTo(tx, ty);
          ctx.stroke();
        }
      }
    });
    ctx.shadowBlur = 0;
  }, [gameState]);

  return (
    <div className="min-h-[100dvh] bg-[#050505] text-white font-sans selection:bg-[#00ffcc]/30 overflow-x-hidden">
      <header className="fixed top-0 left-0 right-0 border-b border-white/10 p-2 sm:p-4 backdrop-blur-md z-50 bg-[#050505]/95">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="p-1.5 sm:p-2 bg-[#00ffcc]/10 rounded-lg"><Gamepad2 className="w-4 h-4 sm:w-6 sm:h-6 text-[#00ffcc]" /></div>
            <h1 className="text-sm sm:text-xl font-bold tracking-tight uppercase italic whitespace-nowrap">Neon Snake Pro</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <button onClick={() => setIsMuted(!isMuted)} className="p-1.5 sm:p-2 hover:bg-white/5 rounded-full transition-colors">
              {isMuted ? <VolumeX className="w-4 h-4 sm:w-5 sm:h-5 text-white/30" /> : <Volume2 className="w-4 h-4 sm:w-5 sm:h-5 text-[#00ffcc]" />}
            </button>
            {user ? (
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-[10px] text-white/50 uppercase tracking-widest font-bold leading-none">Player</p>
                  <p className="text-xs font-medium">{user.displayName}</p>
                </div>
                <button onClick={signOut} className="p-1.5 sm:p-2 hover:bg-white/5 rounded-full transition-colors group"><LogOut className="w-4 h-4 sm:w-5 sm:h-5 text-white/50 group-hover:text-white" /></button>
              </div>
            ) : (
              <button onClick={signIn} className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-white text-black rounded-full font-bold text-[10px] sm:text-sm hover:bg-[#00ffcc] transition-all"><LogIn className="w-3 h-3 sm:w-4 sm:h-4" />Sign In</button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-2 sm:p-4 lg:p-8 pt-20 sm:pt-24 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-[#00ffcc] to-[#ff00ff] rounded-2xl blur opacity-20 group-hover:opacity-30 transition duration-1000"></div>
            <div 
              className="relative bg-black rounded-xl overflow-hidden border-2 shadow-2xl p-4 sm:p-6 lg:p-8"
              style={{ 
                borderColor: DIFFICULTY_CONFIG[gameState.difficulty].color,
                boxShadow: `0 0 30px ${DIFFICULTY_CONFIG[gameState.difficulty].color}33`
              }}
            >
              {/* Score Overlay - Always Visible */}
              <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-[70] flex flex-col pointer-events-none">
                <p className="text-[8px] sm:text-[10px] uppercase tracking-[0.2em] font-black" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>Score</p>
                <p className="text-3xl sm:text-5xl font-black italic tracking-tighter leading-none" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.score.toString().padStart(4, '0')}</p>
              </div>

              {/* Level/Best Overlay */}
              <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-[70] flex gap-4 pointer-events-none text-right">
                <div className="space-y-0">
                  <p className="text-[8px] sm:text-[10px] text-white/30 uppercase tracking-[0.2em] font-black">Level</p>
                  <p className="text-sm sm:text-xl font-black italic uppercase leading-none" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.difficulty}</p>
                </div>
                <div className="space-y-0">
                  <p className="text-[8px] sm:text-[10px] text-white/30 uppercase tracking-[0.2em] font-black">Best</p>
                  <p className="text-sm sm:text-xl font-black italic text-white/60 leading-none">{gameState.highScore.toString().padStart(4, '0')}</p>
                </div>
              </div>

              <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} className="w-full aspect-square max-w-[500px] mx-auto block mt-8 sm:mt-12" />

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
                      <span className="text-[8px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-white/60 whitespace-nowrap">
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
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-white/40 whitespace-nowrap">
                      Difficulty Level: {showLevelUp}
                    </div>
                  </motion.div>
                )}

                {(isConnecting || !isFirestoreReady || showGameOverUI || (gameState.isPaused && !gameState.isGameOver)) && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 sm:p-8 text-center z-[60]">
                    <div className="space-y-4 sm:space-y-6 max-w-sm w-full py-4">
                      {isConnecting ? (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <h2 className="text-4xl font-black italic uppercase tracking-tighter text-[#00ffcc] animate-pulse">Connecting</h2>
                            <p className="text-white/60">Establishing Terminal Link...</p>
                          </div>
                        </div>
                      ) : !isFirestoreReady ? (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <AlertCircle className="w-12 h-12 text-[#ff4d4d] mx-auto mb-4" />
                            <h2 className="text-3xl font-black italic uppercase tracking-tighter text-[#ff4d4d]">Connection Failed</h2>
                            <p className="text-white/60 text-sm">{error || "Could not reach Cloud Firestore backend."}</p>
                          </div>
                          <button 
                            onClick={() => window.location.reload()}
                            className="flex items-center justify-center gap-2 px-8 py-3 bg-[#ff4d4d] text-white rounded-xl font-black uppercase italic hover:scale-105 transition-transform w-full"
                          >
                            <RotateCcw className="w-5 h-5" />
                            Retry Connection
                          </button>
                        </div>
                      ) : showRules ? (
                        <div className="space-y-4 text-left max-h-[85vh] flex flex-col">
                          <div className="space-y-1 text-center pb-2 border-b border-white/5">
                            <h2 className="text-xl font-black italic uppercase tracking-tighter text-[#00ffcc]">Playing Rules and Objectives</h2>
                            <p className="text-white/40 text-[8px] uppercase tracking-widest">How to play and survive</p>
                          </div>
                          
                          <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar flex-1">
                            <section className="space-y-1">
                              <h4 className="text-[9px] font-bold uppercase text-[#00ffcc] tracking-widest">Objective</h4>
                              <p className="text-[11px] text-white/60 leading-relaxed">
                                Navigate the digital void. Consume data packets (food) to expand your system and increase your score. Survive as long as possible. 
                              </p>
                            </section>

                            <section className="space-y-1">
                              <h4 className="text-[9px] font-bold uppercase text-[#ff00ff] tracking-widest">Controls</h4>
                              <ul className="text-[11px] text-white/60 space-y-0.5 list-disc list-inside">
                                <li>Arrow Keys or WASD to navigate</li>
                                <li>Space to toggle pause state</li>
                              </ul>
                            </section>

                            <section className="space-y-1">
                              <h4 className="text-[9px] font-bold uppercase text-[#ff4d4d] tracking-widest">Hazards</h4>
                              <p className="text-[11px] text-white/60 leading-relaxed">Collision with boundary walls, rocks, or fallen logs will result in immediate system failure.</p>
                            </section>
                          </div>

                          <button 
                            onClick={() => setShowRules(false)}
                            className="w-full py-3 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black uppercase italic tracking-widest hover:bg-[#00ffcc]/10 hover:border-[#00ffcc]/50 transition-all"
                          >
                            Return to Terminal
                          </button>
                        </div>
                      ) : showGameOverUI ? (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.8, y: 20 }}
                          animate={{ 
                            opacity: 1, 
                            scale: 1, 
                            y: 0,
                            x: [0, -10, 10, -10, 10, 0]
                          }}
                          transition={{ 
                            duration: 0.6,
                            x: { duration: 0.3, times: [0, 0.2, 0.4, 0.6, 0.8, 1] }
                          }}
                          className="space-y-4 sm:space-y-6 relative"
                        >
                          <div className="absolute inset-0 opacity-[0.03] pointer-events-none flex items-center justify-center">
                            <Skull className="w-32 h-32 sm:w-48 sm:h-48 text-[#ff4d4d]" />
                          </div>
                          <div className="relative z-10 space-y-2 sm:space-y-4">
                            <div className="space-y-1">
                            <motion.div
                              animate={{ 
                                scale: [1, 1.1, 1],
                                rotate: [0, -5, 5, -5, 5, 0],
                                filter: [
                                  "drop-shadow(0 0 0px #ff4d4d)",
                                  "drop-shadow(0 0 20px #ff4d4d)",
                                  "drop-shadow(0 0 0px #ff4d4d)"
                                ]
                              }}
                              transition={{ 
                                duration: 1.5,
                                repeat: Infinity,
                                ease: "easeInOut"
                              }}
                            >
                              <Skull className="w-8 h-8 sm:w-12 sm:h-12 text-[#ff4d4d] mx-auto mb-1" />
                            </motion.div>
                            <motion.h2 
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ 
                                opacity: 1, 
                                y: 0,
                                x: [0, -1, 1, -1, 1, 0]
                              }}
                              transition={{ 
                                delay: 0.2,
                                x: {
                                  duration: 0.2,
                                  repeat: Infinity,
                                  repeatDelay: 4
                                }
                              }}
                              className="text-2xl sm:text-4xl font-black italic uppercase tracking-tighter text-[#ff4d4d] drop-shadow-[0_0_10px_rgba(255,77,77,0.5)]"
                            >
                              Game Over
                            </motion.h2>
                            
                            {isNewTopScore && (
                              <motion.div
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="bg-[#00ffcc] text-black text-[7px] sm:text-[8px] font-black uppercase px-2 py-0.5 rounded-full mx-auto w-fit mt-1 shadow-[0_0_20px_rgba(0,255,204,0.5)] animate-bounce"
                              >
                                New Top 5 Record!
                              </motion.div>
                            )}
                            </div>

                            <div className="bg-white/5 p-2 sm:p-4 rounded-xl border border-white/10 space-y-0 sm:space-y-1">
                              <p className="text-[8px] sm:text-[10px] text-white/40 uppercase font-bold tracking-widest">Final Score</p>
                              <p className="text-2xl sm:text-3xl font-black italic tracking-tighter" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.score.toLocaleString()}</p>
                            </div>

                            {!user && (
                              <div className="pt-2 space-y-2">
                                <p className="text-[8px] text-white/40 font-bold uppercase tracking-widest italic">Sign in to save your score</p>
                                <button 
                                  onClick={async () => {
                                    await signIn();
                                  }}
                                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-white/10 border border-white/20 text-white rounded-lg text-[10px] font-black uppercase italic hover:bg-[#00ffcc] hover:text-black transition-all"
                                >
                                  <LogIn className="w-3 h-3" />
                                  Sign In
                                </button>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ) : (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <h2 className="text-4xl font-black italic uppercase tracking-tighter text-[#00ffcc]">
                              {gameState.isGameStarted ? "Standby" : "Neon Snake Pro"}
                            </h2>
                            <p className="text-white/60">
                              {gameState.isGameStarted ? "Game Paused" : "Initialize System"}
                            </p>
                          </div>
                          <div className="space-y-3">
                            <button 
                              onClick={() => {
                                if (!gameState.isGameStarted) {
                                  resetGame('EASY');
                                } else {
                                  setGameState(p => ({ ...p, isPaused: false }));
                                }
                              }} 
                              className="flex items-center justify-center gap-2 px-8 py-3 bg-[#00ffcc] text-black rounded-xl font-black uppercase italic hover:scale-105 transition-transform w-full"
                            >
                              <Play className="w-5 h-5" />
                              {gameState.isGameStarted ? "Resume" : "Start Game"}
                            </button>
                            {!gameState.isGameStarted && (
                              <p className="text-[10px] text-white/30 font-bold uppercase tracking-widest italic">Defaults to EASY mode</p>
                            )}
                          </div>
                          {!gameState.isGameStarted && (
                            <button 
                              onClick={() => setShowRules(true)}
                              className="w-full py-3 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black uppercase italic tracking-widest hover:bg-white/10 transition-all"
                            >
                              View goals and playing rules
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-black/40 backdrop-blur-md rounded-2xl border border-white/10 p-6 space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {(['EASY', 'MEDIUM', 'HARD', 'INSANE'] as Difficulty[]).map(d => (
                <button 
                  key={d} 
                  onClick={() => resetGame(d)} 
                  className="p-4 bg-white/5 border border-white/10 rounded-xl transition-all group hover:bg-[#00ffcc]/10 hover:border-[#00ffcc]/50 hover:scale-105"
                >
                  <p className="text-xs font-black italic tracking-widest" style={{ color: DIFFICULTY_CONFIG[d].color }}>{d}</p>
                  <p className="text-[8px] text-white/20 uppercase mt-1 group-hover:text-white/40">Launch</p>
                </button>
              ))}
            </div>
            <button 
              onClick={() => setShowRules(true)}
              className="w-full py-3 border border-white/10 rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 hover:text-[#00ffcc] hover:border-[#00ffcc]/30 transition-all"
            >
              Rules & Objectives
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-[#00ffcc]" />
              <h2 className="text-xl font-black italic uppercase tracking-tighter">Hall of Fame</h2>
            </div>
            <span className="text-[10px] bg-[#00ffcc]/10 text-[#00ffcc] px-2 py-1 rounded font-bold uppercase tracking-widest">Global</span>
          </div>

          <div className="bg-white/5 rounded-2xl border border-white/10 overflow-hidden">
            {leaderboard.length > 0 ? (
              <div className="divide-y divide-white/5">
                {leaderboard.map((entry, index) => (
                  <motion.div initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: index * 0.05 }} key={entry.id} className={`p-4 flex items-center justify-between group hover:bg-white/5 transition-colors ${entry.uid === user?.uid ? 'bg-[#00ffcc]/5' : ''}`}>
                    <div className="flex items-center gap-4">
                      <span className={`text-lg font-black italic w-6 ${index < 3 ? 'text-[#00ffcc]' : 'text-white/20'}`}>{(index + 1).toString().padStart(2, '0')}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-sm">{entry.displayName}</p>
                          {entry.uid === user?.uid && <span className="text-[8px] bg-[#00ffcc] text-black px-1 rounded font-black uppercase">You</span>}
                          {entry.difficulty && <span className="text-[8px] px-1 rounded bg-white/5 text-white/40 uppercase">{entry.difficulty}</span>}
                        </div>
                        <p className="text-[10px] text-white/30 uppercase font-medium">{entry.timestamp?.toDate ? entry.timestamp.toDate().toLocaleDateString() : 'Recent'}</p>
                      </div>
                    </div>
                    <p className="text-xl font-black italic tracking-tighter text-[#00ffcc] group-hover:scale-110 transition-transform">{entry.score}</p>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center space-y-4">
                <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mx-auto"><Trophy className="w-6 h-6 text-white/20" /></div>
                <p className="text-sm text-white/40 font-medium">No records found.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

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
import { GoogleGenAI, Modality } from "@google/genai";
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
  Mic,
  MicOff,
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
  EASY: { initialSpeed: 250, speedIncrement: 1, obstacleInterval: 30000, threshold: 0, color: '#10b981', spawnCount: 1 }, // Emerald
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
  if (type === 'gameover') {
    const utterance = new SpeechSynthesisUtterance("Oh No!!");
    utterance.pitch = 0.8;
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
    return;
  }

  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return;
  
  const ctx = new AudioContextClass();
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
    highScore: 0,
    timeSinceLastFood: 0,
  });

  const [user, setUser] = useState<User | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(false);
  const [showMenu, setShowMenu] = useState(true);
  const [showGameOverUI, setShowGameOverUI] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recognitionRef = useRef<any>(null);
  const gameLoopRef = useRef<number | null>(null);
  const lastMoveTimeRef = useRef<number>(0);
  const lastObstacleTimeRef = useRef<number>(0);
  const lastProcessedDirectionRef = useRef<Direction>('UP');
  const lastDifficultyRef = useRef<Difficulty>('EASY');
  const [showLevelUp, setShowLevelUp] = useState<string | null>(null);

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
    console.log(`[SIMULATION START] Difficulty: ${difficulty}`);
    playSound('click');
    lastDifficultyRef.current = difficulty;
    const newFood = { x: 5, y: 5 };
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
      timeSinceLastFood: 0,
    }));
    setShowMenu(false);
    setShowGameOverUI(false);
    lastObstacleTimeRef.current = performance.now();
  }, [playSound]);

  const announceGameOver = useCallback(async (score: number, difficulty: Difficulty) => {
    if (isMuted) return;
    
    try {
      // Use Gemini TTS for high-quality voice announcement
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `Say cheerfully: You scored ${score} points reached ${difficulty} difficulty level.`;
      
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Gemini TTS returns 16-bit PCM
        const pcmData = new Int16Array(bytes.buffer);
        const floatData = new Float32Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
          floatData[i] = pcmData[i] / 32768;
        }
        
        const buffer = audioContext.createBuffer(1, floatData.length, 24000);
        buffer.getChannelData(0).set(floatData);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();
      }
    } catch (error) {
      console.error('Gemini TTS Error, falling back to Web Speech API:', error);
      // Fallback to browser's built-in TTS if Gemini fails or is unavailable
      const utterance = new SpeechSynthesisUtterance(`You scored ${score} points reached ${difficulty} difficulty level.`);
      window.speechSynthesis.speak(utterance);
    }
  }, [isMuted]);

  // Difficulty Progression Notification
  useEffect(() => {
    if (gameState.difficulty !== lastDifficultyRef.current && !gameState.isGameOver && !gameState.isPaused) {
      setShowLevelUp(gameState.difficulty);
      const timer = setTimeout(() => setShowLevelUp(null), 2000);
      lastDifficultyRef.current = gameState.difficulty;
      return () => clearTimeout(timer);
    }
  }, [gameState.difficulty, gameState.isGameOver, gameState.isPaused]);

  // Game Over Sound Trigger & UI Delay
  useEffect(() => {
    if (gameState.isGameOver) {
      playSound('gameover');
      const timer = setTimeout(() => {
        setShowGameOverUI(true);
        announceGameOver(gameState.score, gameState.difficulty);
      }, 2500); // 2.5 second gap
      return () => clearTimeout(timer);
    } else {
      setShowGameOverUI(false);
    }
  }, [gameState.isGameOver, playSound, announceGameOver, gameState.score, gameState.difficulty]);

  // Voice Control Listener
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition && isVoiceEnabled) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let command = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          command += event.results[i][0].transcript;
        }
        command = command.toLowerCase().trim();
        
        // Movement - Process immediately on interim results for speed
        if (command.includes('up')) setGameState(prev => lastProcessedDirectionRef.current !== 'DOWN' ? { ...prev, direction: 'UP' } : prev);
        else if (command.includes('down')) setGameState(prev => lastProcessedDirectionRef.current !== 'UP' ? { ...prev, direction: 'DOWN' } : prev);
        else if (command.includes('left')) setGameState(prev => lastProcessedDirectionRef.current !== 'RIGHT' ? { ...prev, direction: 'LEFT' } : prev);
        else if (command.includes('right')) setGameState(prev => lastProcessedDirectionRef.current !== 'LEFT' ? { ...prev, direction: 'RIGHT' } : prev);

        // Only process menu/difficulty commands on final results to avoid accidental triggers
        const isFinal = event.results[event.results.length - 1].isFinal;
        if (isFinal) {
          console.log('[VOICE COMMAND FINAL]', command);
          if (command.includes('easy')) resetGame('EASY');
          if (command.includes('medium')) resetGame('MEDIUM');
          if (command.includes('hard')) resetGame('HARD');
          if (command.includes('insane')) resetGame('INSANE');
          if (command.includes('pause')) setGameState(prev => ({ ...prev, isPaused: true }));
          if (command.includes('resume')) setGameState(prev => ({ ...prev, isPaused: false }));
          if (command.includes('restart')) setShowMenu(true);
        }
      };

      recognition.onerror = (event: any) => {
        console.error('[VOICE ERROR]', event.error);
        if (event.error === 'not-allowed') setIsVoiceEnabled(false);
      };

      recognition.onend = () => {
        if (isVoiceEnabled) {
          try {
            recognition.start();
          } catch (e) {
            console.error('[VOICE RESTART ERROR]', e);
          }
        }
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
      } catch (e) {
        console.error('[VOICE START ERROR]', e);
      }
    } else {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [isVoiceEnabled, resetGame]);

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
    if (!isAuthReady) return;
    const q = query(collection(db, 'leaderboard'), orderBy('score', 'desc'), limit(10));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LeaderboardEntry[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as LeaderboardEntry));
      setLeaderboard(entries);
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'leaderboard');
    });
    return () => unsubscribe();
  }, [isAuthReady]);

  const submitScore = async (finalScore: number) => {
    if (!user || finalScore <= 0) return;
    try {
      await addDoc(collection(db, 'leaderboard'), {
        displayName: user.displayName || 'Anonymous',
        score: finalScore,
        timestamp: serverTimestamp(),
        uid: user.uid
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'leaderboard');
    }
  };

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
        submitScore(prev.score);
        return { ...prev, isGameOver: true };
      }

      // Check self collision
      if (prev.snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        console.log(`[SIMULATION END] Reason: Self-Collision at {x: ${head.x}, y: ${head.y}}`);
        submitScore(prev.score);
        return { ...prev, isGameOver: true };
      }

      // Check obstacle collision
      if (prev.obstacles.some(o => o.x === head.x && o.y === head.y)) {
        console.log(`[SIMULATION END] Reason: Obstacle Collision at {x: ${head.x}, y: ${head.y}}`);
        submitScore(prev.score);
        return { ...prev, isGameOver: true };
      }

      const newSnake = [head, ...prev.snake];
      let newFood = prev.food;
      let newScore = prev.score;
      let newDifficulty = prev.difficulty;
      let newHighScore = prev.highScore;
      let newTimeSinceLastFood = prev.timeSinceLastFood + 1;

      // Check food collision
      if (head.x === prev.food.x && head.y === prev.food.y) {
        console.log(`[DATA COLLECTION] Rodent captured at {x: ${head.x}, y: ${head.y}}. New Score: ${prev.score + 10}`);
        playSound('eat');
        newScore += 10;
        newHighScore = Math.max(newHighScore, newScore);
        newFood = generatePoint(newSnake, prev.food, prev.obstacles);
        newTimeSinceLastFood = 0;

        // Auto-increase difficulty
        if (newScore >= DIFFICULTY_CONFIG.INSANE.threshold && prev.difficulty !== 'INSANE') {
          newDifficulty = 'INSANE';
          console.log(`[SYSTEM UPGRADE] Difficulty increased to INSANE at score ${newScore}`);
        } else if (newScore >= DIFFICULTY_CONFIG.HARD.threshold && prev.difficulty === 'MEDIUM') {
          newDifficulty = 'HARD';
          console.log(`[SYSTEM UPGRADE] Difficulty increased to HARD at score ${newScore}`);
        } else if (newScore >= DIFFICULTY_CONFIG.MEDIUM.threshold && prev.difficulty === 'EASY') {
          newDifficulty = 'MEDIUM';
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
        timeSinceLastFood: newTimeSinceLastFood
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

    // Draw obstacles (Skulls)
    gameState.obstacles.forEach(o => {
      const ox = o.x * GRID_SIZE;
      const oy = o.y * GRID_SIZE;
      
      ctx.fillStyle = '#ff4d4d';
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#ff4d4d';
      
      // Skull Head
      ctx.beginPath();
      ctx.arc(ox + GRID_SIZE/2, oy + GRID_SIZE/2 - 2, 7, 0, Math.PI * 2);
      ctx.fill();
      
      // Jaw
      ctx.fillRect(ox + GRID_SIZE/2 - 4, oy + GRID_SIZE/2 + 2, 8, 5);
      
      // Eyes
      ctx.fillStyle = '#0a0a0a';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(ox + GRID_SIZE/2 - 3, oy + GRID_SIZE/2 - 3, 2, 0, Math.PI * 2);
      ctx.arc(ox + GRID_SIZE/2 + 3, oy + GRID_SIZE/2 - 3, 2, 0, Math.PI * 2);
      ctx.fill();

      // Nose
      ctx.beginPath();
      ctx.moveTo(ox + GRID_SIZE/2, oy + GRID_SIZE/2);
      ctx.lineTo(ox + GRID_SIZE/2 - 1, oy + GRID_SIZE/2 + 2);
      ctx.lineTo(ox + GRID_SIZE/2 + 1, oy + GRID_SIZE/2 + 2);
      ctx.fill();

      // Teeth lines
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox + GRID_SIZE/2 - 2, oy + GRID_SIZE/2 + 3);
      ctx.lineTo(ox + GRID_SIZE/2 - 2, oy + GRID_SIZE/2 + 7);
      ctx.moveTo(ox + GRID_SIZE/2, oy + GRID_SIZE/2 + 3);
      ctx.lineTo(ox + GRID_SIZE/2, oy + GRID_SIZE/2 + 7);
      ctx.moveTo(ox + GRID_SIZE/2 + 2, oy + GRID_SIZE/2 + 3);
      ctx.lineTo(ox + GRID_SIZE/2 + 2, oy + GRID_SIZE/2 + 7);
      ctx.stroke();
    });

    // Draw Rodent (Food)
    const fx = gameState.food.x * GRID_SIZE;
    const fy = gameState.food.y * GRID_SIZE;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#ffffff';
    
    // Body
    ctx.fillStyle = '#888888';
    ctx.beginPath();
    ctx.ellipse(fx + GRID_SIZE/2, fy + GRID_SIZE/2 + 2, 6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Ears
    ctx.beginPath();
    ctx.arc(fx + GRID_SIZE/2 - 4, fy + GRID_SIZE/2 - 2, 3, 0, Math.PI * 2);
    ctx.arc(fx + GRID_SIZE/2 + 4, fy + GRID_SIZE/2 - 2, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Tail
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fx + GRID_SIZE/2, fy + GRID_SIZE/2 + 6);
    ctx.quadraticCurveTo(fx + GRID_SIZE/2 + 5, fy + GRID_SIZE/2 + 10, fx + GRID_SIZE/2 + 2, fy + GRID_SIZE/2 + 12);
    ctx.stroke();

    // Draw Snake
    const currentColor = DIFFICULTY_CONFIG[gameState.difficulty].color;
    gameState.snake.forEach((segment, index) => {
      const isHead = index === 0;
      ctx.fillStyle = isHead ? currentColor : `${currentColor}cc`;
      ctx.shadowBlur = isHead ? 20 : 0;
      ctx.shadowColor = currentColor;
      
      const x = segment.x * GRID_SIZE;
      const y = segment.y * GRID_SIZE;
      const r = 4; // corner radius
      
      // Rounded segment
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, GRID_SIZE - 2, GRID_SIZE - 2, isHead ? 8 : 4);
      ctx.fill();

      if (isHead) {
        // Eyes
        ctx.fillStyle = 'black';
        ctx.shadowBlur = 0;
        const eyeSize = 2;
        const offset = 5;
        
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
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-[#00ffcc]/30">
      <header className="border-b border-white/10 p-4 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#00ffcc]/10 rounded-lg"><Gamepad2 className="w-6 h-6 text-[#00ffcc]" /></div>
            <h1 className="text-xl font-bold tracking-tight uppercase italic">Neon Snake Pro</h1>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setIsVoiceEnabled(!isVoiceEnabled)} className="p-2 hover:bg-white/5 rounded-full transition-colors flex items-center gap-2">
              {isVoiceEnabled ? <Mic className="w-5 h-5 text-[#00ffcc] animate-pulse" /> : <MicOff className="w-5 h-5 text-white/30" />}
              <span className={`text-[10px] font-bold uppercase tracking-widest ${isVoiceEnabled ? 'text-[#00ffcc]' : 'text-white/20'}`}>Voice</span>
            </button>
            <button onClick={() => setIsMuted(!isMuted)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
              {isMuted ? <VolumeX className="w-5 h-5 text-white/30" /> : <Volume2 className="w-5 h-5 text-[#00ffcc]" />}
            </button>
            {user ? (
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-white/50 uppercase tracking-widest font-bold">Player</p>
                  <p className="text-sm font-medium">{user.displayName}</p>
                </div>
                <button onClick={signOut} className="p-2 hover:bg-white/5 rounded-full transition-colors group"><LogOut className="w-5 h-5 text-white/50 group-hover:text-white" /></button>
              </div>
            ) : (
              <button onClick={signIn} className="flex items-center gap-2 px-4 py-2 bg-white text-black rounded-full font-bold text-sm hover:bg-[#00ffcc] transition-all"><LogIn className="w-4 h-4" />Sign In</button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 lg:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="flex justify-between items-end">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] font-black" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>Score</p>
              <p className="text-5xl font-black italic tracking-tighter" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.score.toString().padStart(4, '0')}</p>
            </div>
            <div className="flex gap-4">
              <div className="text-right space-y-1">
                <p className="text-xs text-white/30 uppercase tracking-[0.2em] font-black">Level</p>
                <p className="text-xl font-black italic uppercase" style={{ color: DIFFICULTY_CONFIG[gameState.difficulty].color }}>{gameState.difficulty}</p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-xs text-white/30 uppercase tracking-[0.2em] font-black">Obstacles</p>
                <p className="text-xl font-black italic text-[#ff00ff]">{gameState.obstacles.length}</p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-xs text-white/30 uppercase tracking-[0.2em] font-black">Best</p>
                <p className="text-xl font-black italic text-white/60">{gameState.highScore.toString().padStart(4, '0')}</p>
              </div>
            </div>
          </div>

          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-[#00ffcc] to-[#ff00ff] rounded-2xl blur opacity-20 group-hover:opacity-30 transition duration-1000"></div>
            <div 
              className="relative bg-black rounded-xl overflow-hidden border-2 shadow-2xl p-4 sm:p-6 lg:p-8"
              style={{ 
                borderColor: DIFFICULTY_CONFIG[gameState.difficulty].color,
                boxShadow: `0 0 30px ${DIFFICULTY_CONFIG[gameState.difficulty].color}33`
              }}
            >
              <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} className="w-full aspect-square max-w-[500px] mx-auto block" />

              <AnimatePresence>
                {showLevelUp && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.5, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.5, y: -20 }}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none z-50"
                  >
                    <div 
                      className="backdrop-blur-md border px-6 py-3 rounded-full shadow-lg"
                      style={{ 
                        backgroundColor: `${DIFFICULTY_CONFIG[showLevelUp as Difficulty].color}33`,
                        borderColor: DIFFICULTY_CONFIG[showLevelUp as Difficulty].color,
                        boxShadow: `0 0 20px ${DIFFICULTY_CONFIG[showLevelUp as Difficulty].color}66`
                      }}
                    >
                      <h3 
                        className="font-bold text-2xl tracking-widest uppercase flex items-center gap-3"
                        style={{ color: DIFFICULTY_CONFIG[showLevelUp as Difficulty].color }}
                      >
                        <Zap className="w-6 h-6 animate-pulse" />
                        System Upgrade: {showLevelUp}
                      </h3>
                    </div>
                  </motion.div>
                )}

                {(showGameOverUI || gameState.isPaused || showMenu) && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center p-8 text-center">
                    <div className="space-y-8 max-w-sm w-full">
                      {showMenu ? (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <h2 className="text-4xl font-black italic uppercase tracking-tighter text-[#00ffcc]">Select Difficulty Level</h2>
                            <p className="text-white/40 text-xs uppercase tracking-widest">Higher difficulty = More obstacles</p>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            {(['EASY', 'MEDIUM', 'HARD', 'INSANE'] as Difficulty[]).map(d => (
                              <button key={d} onClick={() => resetGame(d)} className="p-4 bg-white/5 border border-white/10 rounded-xl hover:bg-[#00ffcc]/10 hover:border-[#00ffcc]/50 transition-all group">
                                <p className="text-sm font-black italic tracking-widest" style={{ color: DIFFICULTY_CONFIG[d].color }}>{d}</p>
                                <p className="text-[8px] text-white/20 uppercase mt-1 group-hover:text-white/40">Initialize</p>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : showGameOverUI ? (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <Skull className="w-12 h-12 text-[#ff4d4d] mx-auto mb-4" />
                            <h2 className="text-4xl font-black italic uppercase tracking-tighter text-[#ff4d4d]">Game Over</h2>
                            <p className="text-white/60">Final Score: {gameState.score}</p>
                            {!user && (
                              <div className="pt-4 space-y-4">
                                <p className="text-[10px] text-[#ff4d4d] font-bold uppercase tracking-widest">Sign in to save this score to the global leaderboard</p>
                                <button 
                                  onClick={async () => {
                                    await signIn();
                                    submitScore(gameState.score);
                                  }}
                                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-white text-black rounded-xl font-black uppercase italic hover:bg-[#00ffcc] transition-all"
                                >
                                  <LogIn className="w-4 h-4" />
                                  Sign In Now
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="space-y-4">
                            <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold">Select New Difficulty</p>
                            <div className="grid grid-cols-2 gap-2">
                              {(['EASY', 'MEDIUM', 'HARD', 'INSANE'] as Difficulty[]).map(d => (
                                <button key={d} onClick={() => resetGame(d)} className="p-2 bg-white/5 border border-white/10 rounded-lg hover:bg-[#00ffcc]/10 hover:border-[#00ffcc]/50 transition-all group">
                                  <p className="text-[10px] font-black italic tracking-widest" style={{ color: DIFFICULTY_CONFIG[d].color }}>{d}</p>
                                </button>
                              ))}
                            </div>
                            <button onClick={() => setShowMenu(true)} className="w-full flex items-center justify-center gap-2 px-8 py-3 bg-[#00ffcc] text-black rounded-xl font-black uppercase italic hover:scale-105 transition-transform"><RotateCcw className="w-5 h-5" />Main Menu</button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          <div className="space-y-2">
                            <h2 className="text-4xl font-black italic uppercase tracking-tighter text-[#00ffcc]">Standby</h2>
                            <p className="text-white/60">Game Paused</p>
                          </div>
                          <button onClick={() => setGameState(p => ({ ...p, isPaused: false }))} className="flex items-center justify-center gap-2 px-8 py-3 bg-[#00ffcc] text-black rounded-xl font-black uppercase italic hover:scale-105 transition-transform"><Play className="w-5 h-5" />Resume</button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col items-center gap-2">
              <Zap className="w-4 h-4 text-[#00ffcc]" />
              <span className="text-[10px] uppercase font-bold text-white/40">{gameState.difficulty}</span>
            </div>
            <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col items-center gap-2">
              <Clock className="w-4 h-4 text-[#ff00ff]" />
              <span className="text-[10px] uppercase font-bold text-white/40">Obstacle in {Math.max(0, Math.ceil((DIFFICULTY_CONFIG[gameState.difficulty].obstacleInterval - (performance.now() - lastObstacleTimeRef.current)) / 1000))}s</span>
            </div>
            <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col items-center gap-2">
              <div className="px-2 py-1 bg-white/10 rounded border border-white/10 text-[8px] font-bold uppercase">Space</div>
              <span className="text-[10px] uppercase font-bold text-white/40">Pause</span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6">
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
                        <p className="font-bold text-sm flex items-center gap-2">{entry.displayName}{entry.uid === user?.uid && <span className="text-[8px] bg-[#00ffcc] text-black px-1 rounded font-black uppercase">You</span>}</p>
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

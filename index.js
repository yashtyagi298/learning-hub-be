import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
const jwtSecret = process.env.JWT_SECRET;
const mongoUri = process.env.MONGODB_URI;

if (!jwtSecret) {
  console.warn("JWT_SECRET is missing. Set it in environment variables.");
}

// ================= CORS CONFIGURATION =================
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like Postman, mobile apps, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.length === 0 ||
        allowedOrigins.includes("*") ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }
      // Production cross-origin issue fix for dynamic Vercel deployments
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 200
  })
);

// Explicitly handle Preflight requests
app.options("*", cors());

app.use(express.json({ limit: "2mb" }));

// --- MongoDB Serverless Connection Caching ---
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not defined in environment variables");
  }

  const db = await mongoose.connect(mongoUri, {
    bufferCommands: false, // Serverless latency issues se bachata hai
  });
  
  cachedDb = db;
  await seedAdmin();
  return db;
}

// Global Middleware for Database Connection
app.use(async (req, res, next) => {
  // OPTIONS/Preflight requests ko DB connect hone se rokein taaki CORS headers fast return ho ske
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("DB Connection Error:", error.message);
    res.status(500).json({ message: "Database connection failed", error: error.message });
  }
});

// ================= SCHEMAS & MODELS =================
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["learner", "admin"], default: "learner" }
  },
  { timestamps: true, collection: "users" }
);

const journalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    todayStudy: String,
    hours: Number,
    topics: String,
    commands: String,
    problems: String,
    goals: String,
    mentorNotes: String,
    images: [String]
  },
  { timestamps: true, collection: "journals" }
);

const taskSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: String,
    description: String,
    checklist: [String],
    status: { type: String, enum: ["todo", "in-progress", "completed", "review"], default: "todo" },
    priority: { type: String, enum: ["Low", "Medium", "High"], default: "Medium" },
    due: String,
    topic: String
  },
  { timestamps: true, collection: "tasks" }
);

const quizAttemptSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    quizType: { type: String, default: "subnetting" },
    score: Number,
    total: Number,
    answers: Object
  },
  { timestamps: true, collection: "quiz_attempts" }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Journal = mongoose.models.Journal || mongoose.model("Journal", journalSchema);
const Task = mongoose.models.Task || mongoose.model("Task", taskSchema);
const QuizAttempt = mongoose.models.QuizAttempt || mongoose.model("QuizAttempt", quizAttemptSchema);

// ================= HELPER FUNCTIONS =================
function startOfDay(date = new Date()) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayKey(date) {
  const indiaOffsetMs = 330 * 60 * 1000;
  return new Date(new Date(date).getTime() + indiaOffsetMs).toISOString().slice(0, 10);
}

function calculateStreak(journals) {
  const activeDays = new Set(journals.map((journal) => dayKey(journal.createdAt)));
  let streak = 0;
  const cursor = startOfDay();
  while (activeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function buildWeeklyStudy(journals) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = startOfDay();
    date.setDate(date.getDate() - (6 - index));
    return { key: dayKey(date), day: date.toLocaleDateString("en-US", { weekday: "short" }), hours: 0, topics: 0 };
  });

  for (const journal of journals) {
    const key = dayKey(journal.createdAt);
    const bucket = days.find((item) => item.key === key);
    if (bucket) {
      bucket.hours += journal.hours ?? 0;
      bucket.topics += String(journal.topics ?? "").split(",").filter(Boolean).length;
    }
  }

  return days.map(({ key, ...item }) => item);
}

function buildHeatmap(journals) {
  const journalMap = new Map();
  for (const journal of journals) {
    const key = dayKey(journal.createdAt);
    const current = journalMap.get(key) ?? { hours: 0, entries: [] };
    current.hours += journal.hours ?? 0;
    current.entries.push(journal);
    journalMap.set(key, current);
  }

  return Array.from({ length: 98 }, (_, index) => {
    const date = startOfDay();
    date.setDate(date.getDate() - (97 - index));
    const key = dayKey(date);
    const entry = journalMap.get(key);
    const minutes = Math.round((entry?.hours ?? 0) * 60);
    return {
      date: key,
      intensity: Math.min(4, Math.ceil((entry?.hours ?? 0) / 1.5)),
      title: entry?.entries?.[0]?.topics || "No study recorded",
      detail: entry?.entries?.[0]?.todayStudy || "No journal saved for this day.",
      minutes
    };
  });
}

function calculateAchievements({ journals, tasks, attempts, bestSubnetting, streak }) {
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const journalDays = new Set(journals.map((journal) => dayKey(journal.createdAt))).size;
  const achievementList = [
    { id: "first-journal", title: "First Journal", description: "Saved your first daily report.", progress: journals.length ? 100 : 0 },
    { id: "daily-reporter", title: "Daily Reporter", description: "Saved reports on 7 different days.", progress: Math.min(100, Math.round((journalDays / 7) * 100)) },
    { id: "seven-day-streak", title: "7 Day Streak", description: "Updated progress for 7 days in a row.", progress: Math.min(100, Math.round((streak / 7) * 100)) },
    { id: "task-finisher", title: "Task Finisher", description: "Completed 10 study tasks.", progress: Math.min(100, Math.round((completedTasks / 10) * 100)) },
    { id: "subnetting-80", title: "Subnetting 80+", description: "Score 80 or more on subnetting MCQ sheet.", progress: Math.min(100, bestSubnetting) },
    { id: "subnetting-master", title: "Subnetting Master", description: "Score 95 or more on subnetting MCQ sheet.", progress: Math.min(100, Math.round((bestSubnetting / 95) * 100)) },
    { id: "quiz-consistency", title: "Quiz Consistency", description: "Submit 5 subnetting attempts.", progress: Math.min(100, Math.round((attempts.length / 5) * 100)) }
  ];

  return achievementList.map((achievement) => ({ ...achievement, unlocked: achievement.progress >= 100 }));
}

function buildTopicProgress(journals) {
  const domains = ["Routing", "Switching", "Wireless", "Security", "Subnetting", "Automation", "IPv6", "OSPF", "VLAN", "ACL"];
  const counts = new Map(domains.map((domain) => [domain, 0]));

  for (const journal of journals) {
    const text = `${journal.topics ?? ""} ${journal.todayStudy ?? ""}`.toLowerCase();
    for (const domain of domains) {
      if (text.includes(domain.toLowerCase())) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }

  const max = Math.max(1, ...counts.values());
  return domains.map((name) => ({ name, value: Math.round(((counts.get(name) ?? 0) / max) * 100), count: counts.get(name) ?? 0 }));
}

async function buildProgressForUser(userId, journalLimit = 90) {
  const [journals, tasks, attempts] = await Promise.all([
    Journal.find({ userId }).sort({ createdAt: -1 }).limit(journalLimit),
    Task.find({ userId }).sort({ createdAt: -1 }),
    QuizAttempt.find({ userId, quizType: "subnetting" }).sort({ createdAt: -1 })
  ]);

  const bestSubnetting = attempts.reduce((best, item) => Math.max(best, item.score ?? 0), 0);
  const hoursStudied = journals.reduce((total, item) => total + (item.hours ?? 0), 0);
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const streak = calculateStreak(journals);
  const weeklyStudy = buildWeeklyStudy(journals);
  const heatmap = buildHeatmap(journals);
  const achievements = calculateAchievements({ journals, tasks, attempts, bestSubnetting, streak });
  const topicProgress = buildTopicProgress(journals);

  return {
    stats: {
      hoursStudied,
      completedTasks,
      totalTasks: tasks.length,
      bestSubnetting,
      attempts: attempts.length,
      journalCount: journals.length,
      streak,
      lastUpdated: journals[0]?.createdAt ?? attempts[0]?.createdAt ?? tasks[0]?.updatedAt ?? null,
      updatedToday: journals.some((journal) => dayKey(journal.createdAt) === dayKey(new Date()))
    },
    weeklyStudy,
    heatmap,
    topicProgress,
    achievements,
    journals,
    tasks,
    attempts
  };
}

function signToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role, email: user.email, name: user.name }, jwtSecret ?? "dev-secret", { expiresIn: "7d" });
}

function publicUser(user) {
  return { id: user._id.toString(), name: user.name, email: user.email, role: user.role };
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing token" });

  try {
    const payload = jwt.verify(token, jwtSecret ?? "dev-secret");
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  next();
}

async function seedAdmin() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  const existing = await User.findOne({ email: process.env.ADMIN_EMAIL.toLowerCase() });
  if (existing) return;
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await User.create({
    name: process.env.ADMIN_NAME ?? "Senior Admin",
    email: process.env.ADMIN_EMAIL.toLowerCase(),
    passwordHash,
    role: "admin"
  });
}

// Helper to catch async route errors
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ================= API ROUTES =================
app.get("/api/health", (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 ? "connected" : "not-connected" }));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ message: "Name, valid email, and 6+ char password required" });
  }
  const exists = await User.findOne({ email: String(email).toLowerCase() });
  if (exists) return res.status(409).json({ message: "Email already exists" });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email: String(email).toLowerCase(), passwordHash, role: "learner" });
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { email, password, expectedRole } = req.body;
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  if (expectedRole && user.role !== expectedRole) {
    return res.status(403).json({ message: user.role === "admin" ? "Use Admin tab for senior login." : "This account is not an admin account." });
  }
  res.json({ user: publicUser(user), token: signToken(user) });
}));

app.get("/api/me", auth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user: publicUser(user) });
}));

app.get("/api/journals", auth, asyncHandler(async (req, res) => {
  const journals = await Journal.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30);
  res.json(journals);
}));

app.post("/api/journals", auth, asyncHandler(async (req, res) => {
  const journal = await Journal.create({ ...req.body, userId: req.user.id });
  res.status(201).json(journal);
}));

app.get("/api/tasks", auth, asyncHandler(async (req, res) => {
  const tasks = await Task.find({ userId: req.user.id }).sort({ createdAt: -1 });
  res.json(tasks);
}));

app.post("/api/tasks", auth, asyncHandler(async (req, res) => {
  const task = await Task.create({ ...req.body, userId: req.user.id });
  res.status(201).json(task);
}));

app.patch("/api/tasks/:id", auth, asyncHandler(async (req, res) => {
  const task = await Task.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true });
  if (!task) return res.status(404).json({ message: "Task not found" });
  res.json(task);
}));

app.post("/api/quiz/subnetting-attempts", auth, asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.create({ userId: req.user.id, quizType: "subnetting", score: req.body.score, total: req.body.total ?? 100, answers: req.body.answers ?? {} });
  res.status(201).json(attempt);
}));

app.get("/api/dashboard", auth, asyncHandler(async (req, res) => {
  const progress = await buildProgressForUser(req.user.id);
  res.json(progress);
}));

app.delete("/api/progress", auth, asyncHandler(async (req, res) => {
  if (req.user.role === "admin") return res.status(400).json({ message: "Admin accounts do not have learner progress to reset" });
  await Promise.all([
    Journal.deleteMany({ userId: req.user.id }),
    Task.deleteMany({ userId: req.user.id }),
    QuizAttempt.deleteMany({ userId: req.user.id })
  ]);
  res.json({ ok: true, message: "Progress reset successfully" });
}));

app.get("/api/admin/overview", auth, adminOnly, asyncHandler(async (_req, res) => {
  const users = await User.find({ role: "learner" }).sort({ createdAt: -1 });
  const rows = await Promise.all(
    users.map(async (user) => {
      const progress = await buildProgressForUser(user._id, 30);
      return {
        user: publicUser(user),
        stats: progress.stats,
        journalCount: progress.stats.journalCount,
        latestJournal: progress.journals[0] ?? null,
        tasks: { total: progress.stats.totalTasks, completed: progress.stats.completedTasks },
        bestSubnetting: progress.stats.bestSubnetting,
        attempts: progress.stats.attempts,
        achievements: progress.achievements,
        updatedToday: progress.stats.updatedToday
      };
    })
  );
  res.json({ learners: rows });
}));

app.get("/api/admin/learners/:id", auth, adminOnly, asyncHandler(async (req, res) => {
  const learner = await User.findOne({ _id: req.params.id, role: "learner" });
  if (!learner) return res.status(404).json({ message: "Learner not found" });
  const progress = await buildProgressForUser(learner._id, 180);
  res.json({ user: publicUser(learner), ...progress });
}));

// Global Error Handler
app.use((error, _req, res, _next) => {
  console.error("Express Error:", error);
  res.status(error.status || 500).json({ message: error.message || "Internal Server Error" });
});

// ================= EXPORT & LOCAL RUNNER =================
export default app;

if (process.env.NODE_ENV !== "production") {
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => console.log(`Local backend running on http://127.0.0.1:${port}`));
}
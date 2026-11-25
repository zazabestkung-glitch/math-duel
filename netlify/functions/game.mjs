import { getStore } from "@netlify/blobs";
import { randomInt, randomUUID } from "node:crypto";

const store = getStore("math-duel-rooms");

const LEVELS = {
  warmup: { seconds: 20 },
  grade3: { seconds: 10 },
  stretch: { seconds: 10 }
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function readJson(key) {
  return (await store.get(key, { type: "json" })) ?? null;
}

async function getRoom(code) {
  return readJson(`room:${code}`);
}

async function saveRoom(code, room) {
  await store.setJSON(`room:${code}`, room);
}

function randomCode() {
  return randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, "0");
}

function randomNumber(min, max) {
  return randomInt(min, max + 1);
}

function timeLimitFor(difficulty) {
  return LEVELS[difficulty].seconds;
}

function makeQuestion(difficulty) {
  let a, b, answer, symbol;

  if (difficulty === "warmup") {
    const operation = randomNumber(0, 3);

    if (operation === 0) {
      a = randomNumber(0, 20);
      b = randomNumber(0, 20);
      answer = a + b;
      symbol = "+";
    } else if (operation === 1) {
      a = randomNumber(0, 20);
      b = randomNumber(0, a);
      answer = a - b;
      symbol = "−";
    } else if (operation === 2) {
      a = randomNumber(2, 5);
      b = randomNumber(2, 5);
      answer = a * b;
      symbol = "×";
    } else {
      b = randomNumber(2, 5);
      answer = randomNumber(1, 5);
      a = b * answer;
      symbol = "÷";
    }
  } else if (difficulty === "grade3") {
    const operation = randomNumber(0, 3);

    if (operation === 0) {
      // Sum is no more than 100.
      a = randomNumber(0, 50);
      b = randomNumber(0, 100 - a);
      answer = a + b;
      symbol = "+";
    } else if (operation === 1) {
      a = randomNumber(0, 100);
      b = randomNumber(0, a);
      answer = a - b;
      symbol = "−";
    } else if (operation === 2) {
      a = randomNumber(2, 10);
      b = randomNumber(2, 10);
      answer = a * b;
      symbol = "×";
    } else {
      b = randomNumber(2, 10);
      answer = randomNumber(2, 10);
      a = b * answer;
      symbol = "÷";
    }
  } else {
    const operation = randomNumber(0, 3);

    if (operation === 0) {
      a = randomNumber(20, 100);
      b = randomNumber(20, 100);
      answer = a + b;
      symbol = "+";
    } else if (operation === 1) {
      a = randomNumber(20, 200);
      b = randomNumber(0, a);
      answer = a - b;
      symbol = "−";
    } else if (operation === 2) {
      a = randomNumber(2, 12);
      b = randomNumber(2, 12);
      answer = a * b;
      symbol = "×";
    } else {
      b = randomNumber(2, 12);
      answer = randomNumber(2, 12);
      a = b * answer;
      symbol = "÷";
    }
  }

  const now = Date.now();
  const seconds = timeLimitFor(difficulty);

  return {
    id: randomUUID(),
    text: `${a} ${symbol} ${b} = ?`,
    answer,
    startedAt: now,
    deadline: now + seconds * 1000
  };
}

function isPlayer(room, role, token) {
  return (role === "p1" || role === "p2") &&
    room.players[role]?.token === token;
}

async function getSubmissions(code, roundId) {
  const [p1, p2] = await Promise.all([
    readJson(`answer:${code}:${roundId}:p1`),
    readJson(`answer:${code}:${roundId}:p2`)
  ]);

  return { p1, p2 };
}

function hasBothAnswered(submissions) {
  return submissions.p1 !== null && submissions.p2 !== null;
}

async function handle(request) {
  if (request.method !== "POST") {
    return response({ error: "Use POST for game requests." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return response({ error: "Invalid request." }, 400);
  }

  const action = body.action;
  const code = String(body.code || "").toUpperCase();
  const role = body.role;
  const token = body.token;

  if (action === "create") {
    const difficulty = LEVELS[body.difficulty] ? body.difficulty : "grade3";

    for (let attempt = 0; attempt < 5; attempt++) {
      const newCode = randomCode();
      if (await getRoom(newCode)) continue;

      const playerToken = randomUUID();
      const room = {
        state: "waiting",
        difficulty,
        players: {
          p1: {
            name: String(body.name || "Player 1").slice(0, 16),
            token: playerToken
          },
          p2: null
        },
        scores: { p1: 0, p2: 0 },
        roundNumber: 0,
        round: null
      };

      await saveRoom(newCode, room);
      return response({ code: newCode, token: playerToken, role: "p1" });
    }

    return response({ error: "Could not create a room. Please try again." }, 500);
  }

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return response({ error: "Enter a valid six-character room code." }, 400);
  }

  if (action === "join") {
    const room = await getRoom(code);

    if (!room || room.state !== "waiting" || room.players.p2) {
      return response({ error: "Room not found or already full." }, 404);
    }

    const playerToken = randomUUID();
    room.players.p2 = {
      name: String(body.name || "Player 2").slice(0, 16),
      token: playerToken
    };
    room.state = "playing";
    room.roundNumber = 1;
    room.round = makeQuestion(room.difficulty);

    await saveRoom(code, room);
    return response({ code, token: playerToken, role: "p2" });
  }

  const room = await getRoom(code);
  if (!room) return response({ error: "Room not found." }, 404);

  if (!isPlayer(room, role, token)) {
    return response({ error: "This device is not registered in that room." }, 403);
  }

  if (action === "state") {
    if (!room.round) {
      return response({
        state: room.state,
        difficulty: room.difficulty,
        players: {
          p1: room.players.p1?.name,
          p2: room.players.p2?.name || null
        },
        scores: room.scores,
        displayScores: room.scores,
        round: null,
        roundNumber: room.roundNumber,
        timeLeft: 0,
        submitted: false,
        roundResult: null
      });
    }

    const submissions = await getSubmissions(code, room.round.id);
    const bothAnswered = hasBothAnswered(submissions);
    const timerExpired = Date.now() >= room.round.deadline;
    const resolved = bothAnswered || timerExpired;

    const roundResult = resolved
      ? {
          p1Correct: submissions.p1 !== null &&
            submissions.p1.answer === room.round.answer,
          p2Correct: submissions.p2 !== null &&
            submissions.p2.answer === room.round.answer
        }
      : null;

    const displayScores = { ...room.scores };
    if (roundResult && room.state !== "finished") {
      if (roundResult.p1Correct) displayScores.p1++;
      if (roundResult.p2Correct) displayScores.p2++;
    }

    return response({
      state: room.state,
      difficulty: room.difficulty,
      players: {
        p1: room.players.p1.name,
        p2: room.players.p2?.name || "Player 2"
      },
      scores: room.scores,
      displayScores,
      round: {
        text: room.round.text,
        answer: resolved ? room.round.answer : null
      },
      roundNumber: room.roundNumber,
      timeLeft: Math.max(0, Math.ceil((room.round.deadline - Date.now()) / 1000)),
      submitted: submissions[role] !== null,
      roundResult
    });
  }

  if (action === "submit") {
    if (room.state !== "playing" || !room.round) {
      return response({ error: "The game is not accepting answers." }, 409);
    }

    if (Date.now() >= room.round.deadline) {
      return response({ error: "Time is up for this question." }, 409);
    }

    const answer = Number(body.answer);
    if (!Number.isInteger(answer) || answer < -1000 || answer > 1000) {
      return response({ error: "Enter a whole-number answer." }, 400);
    }

    const key = `answer:${code}:${room.round.id}:${role}`;
    if (await readJson(key)) {
      return response({ error: "You already submitted an answer." }, 409);
    }

    await store.setJSON(key, { answer });
    return response({ ok: true });
  }

  if (action === "advance") {
    if (role !== "p1") {
      return response({ error: "Only the host can start the next question." }, 403);
    }

    if (room.state !== "playing" || !room.round) {
      return response({ error: "The round cannot advance right now." }, 409);
    }

    const submissions = await getSubmissions(code, room.round.id);
    const resolved = hasBothAnswered(submissions) || Date.now() >= room.round.deadline;

    if (!resolved) {
      return response({ error: "Wait for both answers or for time to run out." }, 409);
    }

    if (submissions.p1?.answer === room.round.answer) room.scores.p1++;
    if (submissions.p2?.answer === room.round.answer) room.scores.p2++;

    if (room.scores.p1 >= 5 || room.scores.p2 >= 5) {
      room.state = "finished";
    } else {
      room.roundNumber++;
      room.round = makeQuestion(room.difficulty);
    }

    await saveRoom(code, room);
    return response({ ok: true });
  }

  if (action === "restart") {
    if (role !== "p1") {
      return response({ error: "Only the host can restart the match." }, 403);
    }

    if (room.state !== "finished") {
      return response({ error: "The match is not finished yet." }, 409);
    }

    room.state = "playing";
    room.scores = { p1: 0, p2: 0 };
    room.roundNumber = 1;
    room.round = makeQuestion(room.difficulty);

    await saveRoom(code, room);
    return response({ ok: true });
  }

  return response({ error: "Unknown game action." }, 400);
}

export default async request => {
  try {
    return await handle(request);
  } catch (error) {
    console.error("Math Duel function error:", error);
    return response({
      error: "Server error. Check the Netlify function logs."
    }, 500);
  }
};

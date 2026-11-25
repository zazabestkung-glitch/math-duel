import { getStore } from "@netlify/blobs";
import { randomInt, randomUUID } from "node:crypto";

const store = getStore("math-duel-rooms");

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function randomCode() {
  return randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, "0");
}

function makeQuestion() {
  const rand = (min, max) => randomInt(min, max + 1);
  const operation = rand(0, 3);
  let a, b, answer, symbol;

  if (operation === 0) {
    a = rand(1, 10); b = rand(1, 10);
    answer = a + b; symbol = "+";
  } else if (operation === 1) {
    a = rand(1, 10); b = rand(1, a);
    answer = a - b; symbol = "−";
  } else if (operation === 2) {
    a = rand(1, 5); b = rand(1, 5);
    answer = a * b; symbol = "×";
  } else {
    b = rand(1, 5); answer = rand(1, 10);
    a = b * answer; symbol = "÷";
  }

  return {
    id: randomUUID(),
    text: `${a} ${symbol} ${b} = ?`,
    answer
  };
}

async function getRoom(code) {
  return store.get(`room:${code}`, { type: "json" });
}

async function saveRoom(code, room) {
  await store.setJSON(`room:${code}`, room);
}

function hasPlayer(room, role, token) {
  return (role === "p1" || role === "p2") &&
    room.players[role]?.token === token;
}

async function getSubmissions(code, roundId) {
  const [p1, p2] = await Promise.all([
    store.get(`answer:${code}:${roundId}:p1`, { type: "json" }),
    store.get(`answer:${code}:${roundId}:p2`, { type: "json" })
  ]);
  return { p1, p2 };
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
    let roomCode;
    let room;

    for (let i = 0; i < 5; i++) {
      roomCode = randomCode();
      if (!await getRoom(roomCode)) {
        const playerToken = randomUUID();
        room = {
          state: "waiting",
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
        await saveRoom(roomCode, room);
        return response({ code: roomCode, token: playerToken, role: "p1" });
      }
    }
    return response({ error: "Could not create a room. Try again." }, 500);
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
    room.round = makeQuestion();
    await saveRoom(code, room);

    return response({ code, token: playerToken, role: "p2" });
  }

  const room = await getRoom(code);
  if (!room) return response({ error: "Room not found." }, 404);
  if (!hasPlayer(room, role, token)) {
    return response({ error: "This device is not registered in that room." }, 403);
  }

  if (action === "state") {
    if (!room.round) {
      return response({
        state: room.state,
        players: {
          p1: room.players.p1?.name,
          p2: room.players.p2?.name || null
        },
        scores: room.scores,
        displayScores: room.scores,
        round: null,
        roundNumber: room.roundNumber,
        submitted: false,
        roundResult: null
      });
    }

    const submissions = await getSubmissions(code, room.round.id);
    const bothSubmitted = submissions.p1 !== null && submissions.p2 !== null;
    const roundResult = bothSubmitted ? {
      p1Correct: submissions.p1.answer === room.round.answer,
      p2Correct: submissions.p2.answer === room.round.answer
    } : null;

    const displayScores = { ...room.scores };
    if (roundResult) {
      if (roundResult.p1Correct) displayScores.p1++;
      if (roundResult.p2Correct) displayScores.p2++;
    }

    const finished = room.state === "finished";
    const result = {
      state: room.state,
      players: {
        p1: room.players.p1.name,
        p2: room.players.p2.name
      },
      scores: room.scores,
      displayScores: finished ? room.scores : displayScores,
      round: {
        text: room.round.text,
        answer: bothSubmitted ? room.round.answer : null
      },
      roundNumber: room.roundNumber,
      submitted: submissions[role] !== null,
      roundResult
    };

    return response(result);
  }

  if (action === "submit") {
    if (room.state !== "playing" || !room.round) {
      return response({ error: "The game is not accepting answers." }, 409);
    }

    const answer = Number(body.answer);
    if (!Number.isInteger(answer) || answer < -1000 || answer > 1000) {
      return response({ error: "Enter a whole-number answer." }, 400);
    }

    const key = `answer:${code}:${room.round.id}:${role}`;
    const existing = await store.get(key, { type: "json" });
    if (existing !== null) {
      return response({ error: "You already submitted this answer." }, 409);
    }

    await store.setJSON(key, { answer });
    return response({ ok: true });
  }

  if (action === "advance") {
    if (role !== "p1") return response({ error: "Player 1 starts the next question." }, 403);
    if (room.state !== "playing" || !room.round) {
      return response({ error: "The round cannot advance right now." }, 409);
    }

    const submissions = await getSubmissions(code, room.round.id);
    if (submissions.p1 === null || submissions.p2 === null) {
      return response({ error: "Both players must answer first." }, 409);
    }

    if (submissions.p1.answer === room.round.answer) room.scores.p1++;
    if (submissions.p2.answer === room.round.answer) room.scores.p2++;

    if (room.scores.p1 >= 5 || room.scores.p2 >= 5) {
      room.state = "finished";
    } else {
      room.roundNumber++;
      room.round = makeQuestion();
    }

    await saveRoom(code, room);
    return response({ ok: true });
  }

  if (action === "restart") {
    if (role !== "p1") return response({ error: "Player 1 can restart the match." }, 403);
    if (room.state !== "finished") {
      return response({ error: "The match is not finished yet." }, 409);
    }

    room.state = "playing";
    room.scores = { p1: 0, p2: 0 };
    room.roundNumber = 1;
    room.round = makeQuestion();
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
    return response({ error: "Server error. Check the Netlify function logs." }, 500);
  }
};
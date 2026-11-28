'use strict';

const { raceBoard, divisionCode } = require('./race-leaderboard');

const isRace = event => !!event && (event.raceMode === 'race' || event.id === 'evmvwkp907');

function athleteKey(reg) {
  if (reg.athlete_user) return 'account:' + reg.athlete_user;
  if (reg.user_id && reg.who === 'me') return 'account:' + reg.user_id;
  if (reg.who && !['me','offline'].includes(reg.who)) return 'child:' + reg.who;
  return 'registration:' + reg.id;
}

function raceHistory(events, registrations, scores) {
  const regsById = new Map(registrations.map(r => [r.id, r]));
  const regsByPub = new Map(registrations.map(r => [r.pub, r]));
  const regsByEvent = new Map();
  const scoresByEvent = new Map();
  function append(map, key, row) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  for (const reg of registrations) append(regsByEvent, reg.event_id, reg);
  for (const score of scores) {
    const reg = regsById.get(score.reg_id);
    if (reg) append(scoresByEvent, reg.event_id, score);
  }
  const boards = new Map();
  const byAthlete = new Map();
  for (const event of events) {
    if (!isRace(event) || event.status === 'draft') continue;
    const board = raceBoard(event, regsByEvent.get(event.id) || [], scoresByEvent.get(event.id) || []);
    boards.set(event.id, board);
    for (const division of board.divisions) {
      const date = (event.workouts || []).find(w => w.divs?.includes(division.id))?.day || event.date || '';
      for (const row of division.entries) {
        if (row.seconds === null) continue;
        const keys = new Set(row.publicId.map(id => regsByPub.get(id)).filter(Boolean).map(athleteKey));
        for (const key of keys) append(byAthlete, key, {
          eventId: event.id, event: event.name, date, category: division.name,
          division: divisionCode(division.id), level: division.level, seconds: row.seconds,
          place: row.absolutePlace, ageGroup: row.ageGroup, agePlace: row.agePlace
        });
      }
    }
  }
  const count = new Map([...byAthlete].map(([key, history]) => [key, new Set(history.map(r => r.eventId)).size]));
  for (const board of boards.values()) {
    for (const division of board.divisions) {
      for (const row of division.entries) {
        row.races = row.publicId.map(id => {
          const reg = regsByPub.get(id);
          return reg ? count.get(athleteKey(reg)) || 0 : 0;
        });
        row.raceCount = row.races.length === 1 ? row.races[0] : null;
      }
    }
  }
  return {
    boards,
    forRegistration(id) {
      const reg = regsById.get(id);
      const history = reg ? byAthlete.get(athleteKey(reg)) || [] : [];
      return [...history].sort((a,b)=>b.date.localeCompare(a.date)||a.division.localeCompare(b.division));
    }
  };
}
module.exports = { isRace, raceHistory };

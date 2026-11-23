'use strict';

/*
 * Read-only bridge between published historical pair results and user profiles.
 * Importing an archive never creates registrations or grants account access.
 * An exact name match is useful for displaying public results, not for identity
 * verification or claiming payouts, permissions or competition registrations.
 */
const normalized = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

const nameKey = value => {
  const words = normalized(value).split(' ').filter(Boolean);
  return words.length >= 2 ? words.slice(0, 2).sort().join('|') : '';
};

const profileKey = person => {
  if (!person || !normalized(person.first) || !normalized(person.last)) return '';
  return nameKey(String(person.last) + ' ' + String(person.first));
};

const ageAt = (dob, date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob || ''))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const b = dob.split('-').map(Number), d = date.split('-').map(Number);
  return d[0] - b[0] - (d[1] < b[1] || (d[1] === b[1] && d[2] < b[2]) ? 1 : 0);
};

const ageCompatible = (person, div, eventDate) => {
  const age = ageAt(person.dob, eventDate);
  if (age === null) return true; // Historical protocols do not contain DOB.
  if (age < 0 || age > 100) return false;
  if (/^(kids-|rx-)/.test(div.id)) return age <= 19;
  return age >= 16;
};

function archiveEntries(archive) {
  if (!archive?.event || !archive.results) return [];
  const event = archive.event;
  const output = [];
  for (const div of event.divisions || []) {
    const ws = (event.workouts || []).filter(w => !w.divs?.length || w.divs.includes(div.id));
    for (const [i, row] of (archive.results[div.id] || []).entries()) {
      // Unverified team lineups remain in public leaderboards but are never
      // assigned to a person's account based on the team name alone.
      if (!Array.isArray(row.team) || row.team.length !== 2) continue;
      for (const member of row.team) {
        const key = nameKey(member);
        if (!key) continue;
        output.push({
          id: event.id + ':' + div.id + ':' + i + ':' + key,
          key, athlete: String(member).trim(), event: event.id, eventName: event.name,
          date: event.date, dateEnd: event.dateEnd || event.date,
          div: div.id, category: div.name, team: row.n,
          place: Number.isInteger(row.place) ? row.place : null,
          pts: typeof row.pts === 'number' ? row.pts : null,
          workouts: ws.map((w, j) => ({
            id: w.id, name: w.name, result: row.r?.[j] ?? null,
            place: row.wr?.[j] ?? null,
          })),
        });
      }
    }
  }
  return output;
}

function historyForPerson(archive, person, who = 'self') {
  const key = profileKey(person);
  if (!key) return [];
  const divisionById = new Map((archive?.event?.divisions || []).map(d => [d.id, d]));
  return archiveEntries(archive)
    .filter(row => row.key === key && ageCompatible(person, divisionById.get(row.div) || { id: '' }, row.date))
    .map(({ key: _key, ...row }) => ({ ...row, who }));
}

function archivePeople(archive) {
  const map = new Map();
  for (const row of archiveEntries(archive)) {
    if (!map.has(row.key)) map.set(row.key, { id: row.key, name: row.athlete, starts: 0 });
    map.get(row.key).starts++;
  }
  return [...map.values()];
}

function historyForArchiveName(archive, key) {
  if (typeof key !== 'string' || key.length > 150) return [];
  return archiveEntries(archive)
    .filter(row => row.key === key)
    .map(({ key: _key, ...row }) => ({ ...row, who: 'self' }));
}

module.exports = { normalized, nameKey, profileKey, ageAt, archiveEntries, archivePeople, historyForPerson, historyForArchiveName };

export function pointsForVote(vote, results) {
  let points = results.trips.includes(vote.bonus) ? 5 : 0;
  vote.top.forEach((candidate, rank) => {
    const finalRank = results.top.indexOf(candidate);
    if (finalRank === rank) points += rank === 0 ? 30 : 10;
    else if (finalRank >= 0) points += 6;
    else if (results.semi.includes(candidate)) points += 2;
  });
  return points;
}

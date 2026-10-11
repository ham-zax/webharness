function tokens(value) {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Metadata only: long bodies cannot swamp the declared applicability description.
export function search(skills, query) {
  if (!query) return skills.map(card => ({ card, score: 0 }));
  const normalized = query.trim().toLowerCase();
  const exact = skills.filter(card => [card.id, card.name, card.id.split('/')[1]].includes(normalized));
  if (exact.length) return exact.map(card => ({ card, score: 1 }));
  const terms = [...new Set(tokens(query))];
  const docs = skills.map(card => ({ card, terms: tokens(`${card.name} ${card.description}`) }));
  const average = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / (docs.length || 1);
  const frequency = new Map(terms.map(term => [term, docs.filter(doc => doc.terms.includes(term)).length]));
  return docs.map(doc => {
    let score = 0;
    for (const term of terms) {
      const count = doc.terms.filter(word => word === term).length;
      if (!count) continue;
      const idf = Math.log(1 + (docs.length - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5));
      score += idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * doc.terms.length / average));
    }
    return { card: doc.card, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id, 'en'));
}

export function reply(questions, { fit = 0.9, score = 1.9, confidence = 0.8 } = {}) {
  const answers = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const ids = Object.keys(question.criteria);
      const choice = ids.find(id => id !== '__none__');
      answers[key] = { type: 'choice', choice, confidence,
        probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 0.8 : 0.2 / (ids.length - 1)])) };
    } else if (question.type === 'noul') answers[key] = { type: 'noul', noul: fit };
    else answers[key] = { type: 'score', score, confidence, probabilities: { '0': 0.02, '1': 0.06, '2': 0.92 } };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 20 } };
}

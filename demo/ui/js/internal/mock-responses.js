/**
 * Mock LLM Responses — used when no LLM server is available.
 * Returns canned responses matched by keyword from the test fixture.
 */
var MockLLM = (function () {
  var responses = [
    'Based on the retrieval pipeline, I found relevant context from earlier in our conversation to answer that.',
    'The BM25 search identified matching nodes in the chain. Here is what I found from the recalled context.',
    'Interesting question. Let me pull from the memory graph to give you a useful answer.',
    'I found relevant nodes outside the current window. The recall buffer has been populated with historical context.',
    'The bloom filter confirmed potential matches in the active chain. BM25 scored and ranked the results.',
    'Searching the sliding window and recall buffer for relevant context to synthesize a response.'
  ];
  var idx = 0;

  function getResponse(query) {
    var q = query.toLowerCase();
    if (q.indexOf('pineapple') !== -1 || q.indexOf('code word') !== -1 || q.indexOf('secret') !== -1) {
      return 'The secret code word is pineapple \u2014 you set it up back in turn 4 during the BM25 Python session. Retrieved from node 4 via BM25 recall.';
    }
    if (q.indexOf('dog') !== -1 || q.indexOf('corgi') !== -1 || q.indexOf('biscuit') !== -1 || q.indexOf('mochi') !== -1) {
      return "From memory chain: your friend has a corgi named Biscuit who herds cats. You're getting your own corgi named Mochi. Vet is Dr. Nakamura, Hillside Animal Clinic, 4th street.";
    }
    if (q.indexOf('bm25') !== -1 || q.indexOf('python') !== -1 || q.indexOf('k1') !== -1) {
      return 'Retrieved from chain: Python 3.11.4, project at C:\\Users\\dev\\projects\\memory-engine. BM25 settings for conversational text: k1=1.2, b=0.4.';
    }
    if (q.indexOf('tokyo') !== -1 || q.indexOf('japan') !== -1 || q.indexOf('cherry') !== -1 || q.indexOf('flight') !== -1) {
      return 'From recalled nodes: Tokyo trip March 28 - April 8, ANA flight NH109. Airalo eSIM, Suica card, budget ~\u00A510,000-15,000/day. Vegetarian: try shojin ryori.';
    }
    if (q.indexOf('music') !== -1 || q.indexOf('beat') !== -1 || q.indexOf('fl studio') !== -1) {
      return "From memory: FL Studio on Windows, lo-fi at 80 BPM, trap at 140 BPM. Splice username: beatmaker_mochi. Focusrite Scarlett 2i2 interface.";
    }
    if (q.indexOf('pc') !== -1 || q.indexOf('cpu') !== -1 || q.indexOf('build') !== -1 || q.indexOf('ryzen') !== -1) {
      return 'From chain: Ryzen 7 7800X3D, MSI MAG B650 TOMAHAWK, 32GB DDR5-6000, RTX 4060 Ti, Fractal Meshify 2, Corsair RM750x. Microcenter Tustin.';
    }
    var resp = responses[idx % responses.length];
    idx++;
    return resp;
  }

  return { getResponse: getResponse };
})();

const launch = jest.fn(async () => ({
  newPage: jest.fn(async () => ({
    goto: jest.fn(async () => {}),
    waitForSelector: jest.fn(async () => {}),
    evaluate: jest.fn(async () => []),
    click: jest.fn(async () => {}),
    waitForFunction: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    setDefaultNavigationTimeout: jest.fn(),
    setDefaultTimeout: jest.fn(),
    $: jest.fn(async () => ({})), // for Transnet
  })),
  close: jest.fn(async () => {}),
}));

export default {
  launch, 
};

export interface LoggingModel {
  timestamp: string;
  id: string;
  request: any;
  response: {
    body: any;
  };
}


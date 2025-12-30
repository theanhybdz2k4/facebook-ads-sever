export const LoggerOptions: any = {
  pinoHttp: {
    customProps: () => ({
      context: 'HTTP',
    }),
  },
};


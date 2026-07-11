module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // NOTE: this must always be the LAST plugin in the list.
      'react-native-reanimated/plugin',
    ],
  };
};

var path = require('path');
var precss = require('precss');
var autoprefixer = require('autoprefixer');
var webpack = require('webpack');
var ExtractTextPlugin = require('extract-text-webpack-plugin');
var NpmInstallPlugin = require('npm-install-webpack-plugin');

module.exports = {
    devtool: 'cheap-module-eval-source-map',
    entry: [
        'eventsource-polyfill', // necessary for hot reloading with IE
        'webpack-hot-middleware/client',
        './src/index'
    ],
    output: {
        path: path.join(__dirname, 'dist'),
        filename: 'bundle.js',
        publicPath: '/static/'
    },
    plugins: [
        new webpack.HotModuleReplacementPlugin(),
        new webpack.NoErrorsPlugin(),
        new ExtractTextPlugin('[name].css'),
        new NpmInstallPlugin({
            dev: function(module, path) {
                return [
                    'babel-preset-react-hmre',
                    'webpack-dev-middleware',
                    'webpack-hot-middleware',
                ].indexOf(module) !== -1;
            },
        }),
    ],
    postcss: function() {
        return [precss, autoprefixer];
    },
    module: {
    	loaders: [
        	{
                test: /\.js$/,
                loaders: ['babel'],
                include: path.join(__dirname, 'src')
        	},
            {
                test: /\.css$/,
                loader: ExtractTextPlugin.extract('style-loader','css-loader','postcss-loader')
            },
            {
                test: /\.scss$/,
                loader: 'style!css!sass'
            }
    	]
    },
    resolve: {
        extensions: ['', '.js', '.sass'],
        root: [path.join(__dirname, './src')]
    }
};

import React, { Component } from 'react';

import { createHistory, useBasename } from 'history';
import { Router, Route, IndexRoute, Link } from 'react-router';

import App from './App';
import Index from './containers/Index';
import Games from './containers/Games';
import Game from './containers/Game';
import Turn from './containers/Turn';

const history = useBasename(createHistory)({
  basename: ''
})

class RouterContainer extends Component {
    render() {
      return (
        <Router history={history}>
          <Router path="/" component={App}>
              <IndexRoute component={Index} />
              <Route path="games" component={Games} />
              <Route path="game/:gameID" component={Game} />
              <Route path="game/:gameID/:player" component={Turn} />
          </Router>
        </Router>
      )
    }
}

export default RouterContainer

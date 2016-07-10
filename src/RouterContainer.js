import React, { Component } from 'react';

import { Router, Route, IndexRoute, Link, browserHistory } from 'react-router';
import history from './history';

import App from './App';
import Index from './containers/Index';
import Players from './containers/Players';
import Game from './containers/Game';
import Turn from './containers/Turn';

class RouterContainer extends Component {

    renderRoutes() {
        return (
            <Route path="/" component={App}>
                <IndexRoute component={Index} />
                <Route path="players" component={Players} />
                <Route path="game" component={Game} />
                <Route path="player/:player" component={Turn} />
            </Route>
        );
    }

    render() {
      return (
        <Router history={history} routes={this.renderRoutes()} />
      )
    }

}

export default RouterContainer

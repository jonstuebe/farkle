import React from 'react';
import Reflux from 'reflux';

import PlayersStore from '../stores/PlayersStore';
import PlayersActions from '../actions/PlayersActions';

import history from '../history';

import Button from '../components/Button';

const Index = React.createClass({

    mixins: [
        Reflux.connect(PlayersStore, 'players'),
    ],

    newGame() {
        PlayersActions.removeAll();
        history.pushState(null, '/players');
    },

    render(){

        let resume = null;
        let newGame = <Button to={'/players'}>Start New Game</Button>;
        if(this.state.players.length > 0) {
            resume = <Button to={'/players'} style={{ marginBottom: 10 }}>Resume Game</Button>;
            newGame = <Button onClick={this.newGame}>Start New Game</Button>;
        }

        return (
            <div className='splash'>
                <h1 className='splash__title'><span>Farkl</span><span>e</span></h1>
                <div style={{ position: 'fixed', bottom: 20, width: '100%' }}>
                    {resume}
                    {newGame}
                </div>

            </div>
        )
    }
});

export default Index

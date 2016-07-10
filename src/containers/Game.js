import React from 'react';
import Reflux from 'reflux';
import { Link } from 'react-router';
import _ from 'lodash';

import history from '../history';

import PlayersStore from '../stores/PlayersStore';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItem from '../components/ListItem';
import BottomDrawer from '../components/BottomDrawer';
import Button from '../components/Button';

const Game = React.createClass({

    mixins: [
        Reflux.connect(PlayersStore, 'players'),
    ],

    getPlayerSlug(player) {
        return player.first_name.toLowerCase() + '-' + player.last_name.toLowerCase();
    },

    onSelectPlayer(player) {
        history.replaceState(null, `/player/${this.getPlayerSlug(player)}`);
    },

    renderPlayers() {

        let players = this.state.players.map((player, index) => {
            return (
                <ListItem title={`${player.first_name} ${player.last_name}`} details={`${player.points} points`} key={index} onClick={() => {
                        this.onSelectPlayer(player);
                }} />
            );
        })

        return players;

    },

    render(){

        return (
            <div>
                <TitleBar title="Game" back={'/players'} />
                <ListItems>
                    {this.renderPlayers()}
                </ListItems>
            </div>
        )
    }
});

export default Game;

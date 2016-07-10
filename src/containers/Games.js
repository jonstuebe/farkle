import React from 'react';
import { Link } from 'react-router';

import Reflux from 'reflux';
import Actions from '../actions/Actions';
import GamesStore from '../stores/GamesStore';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItemGame from '../components/ListItemGame';

const Games = React.createClass({

    mixins: [
        Reflux.connect(GamesStore, 'games'),
    ],

    componentWillMount() {


    },

    render(){
        return (
            <div>
                <TitleBar title="Games" back={false} />
                <ListItems>

                    {this.state.games.map(function(game, index){
                        return <ListItemGame players={game.players} details="Your Turn" active={false} id={game.id} key={index} />
                    })}

                </ListItems>
            </div>
        )
    },

});

export default Games;
